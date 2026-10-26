"""Tillith chat transport using the core's durable checkpoint and run lifecycle."""

import asyncio
import hashlib
import json
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Column,
    Integer,
    MetaData,
    String,
    Table,
    delete,
    insert,
    select,
    update,
)

from astrbot.core.db.po import ConversationV2, PlatformMessageHistory
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.chat_service import (
    ChatServiceError,
    build_webchat_unified_msg_origin,
    find_turn_range,
    is_latest_checkpoint,
)

versions = Table(
    "tillith_message_versions",
    MetaData(),
    Column("id", String, primary_key=True),
    Column("session_id", String, nullable=False, index=True),
    Column("creator", String, nullable=False),
    Column("user_message_id", Integer, nullable=False),
    Column("fingerprint", String, nullable=False),
    Column("created_at", String, nullable=False),
    Column("snapshot", JSON, nullable=False),
)


class TillithMessageService:
    """Keep message operations on the existing chat service and authenticated owner."""

    def __init__(self, db, chat, open_api):
        self.db = db
        self.chat = chat
        self.open_api = open_api
        self.locks = defaultdict(asyncio.Lock)
        self.schema_lock = asyncio.Lock()
        self.schema_ready = False

    async def ensure_schema(self):
        """Create the isolated version table without modifying upstream metadata."""
        async with self.schema_lock:
            if not self.schema_ready:
                async with self.db.engine.begin() as conn:
                    await conn.run_sync(
                        lambda sync: versions.create(sync, checkfirst=True)
                    )
                self.schema_ready = True

    async def require_owned(self, username, session_id):
        """Return a live owned webchat session or a non-disclosing error."""
        session = await self.db.get_platform_session_by_id(session_id)
        if (
            not session
            or session.creator != username
            or session.platform_id != "webchat"
        ):
            raise ApiError("Session not found", status_code=404)
        return session

    async def start(self, username, data):
        """Start a checkpointed run, editing or regenerating the latest turn if requested.

        Args:
            username: Authenticated API key identity, never a client-selected identity.
            data: Validated public message fields.

        Returns:
            The core SSE iterator and its registered run identifier.
        """
        session_id = data["session_id"]
        async with self.locks[session_id]:
            await self.require_owned(username, session_id)
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Session has an active response", status_code=409)
            config_id, err = self.open_api.resolve_chat_config_id(
                data, self.open_api.get_chat_config_list()
            )
            if err:
                raise ApiError("Configuration not found", status_code=400)
            if await self.open_api.update_session_config_route(
                username=username, session_id=session_id, config_id=config_id
            ):
                raise ApiError("Configuration route could not be updated")
            payload = {
                key: data[key]
                for key in (
                    "session_id",
                    "message",
                    "flags",
                    "selected_provider",
                    "selected_model",
                )
                if key in data
            }
            # Explicit false prevents chat keys from acquiring administrator tool access.
            payload["_api_key_allow_admin_role"] = False
            if data["t"] == "edit":
                await self.snapshot(username, session_id, data["message_id"])
                await self.chat.update_message(username, data)
                record = await self.db.get_platform_message_history_by_id(
                    data["message_id"]
                )
                payload.update(
                    message=record.content["message"],
                    _skip_user_history=True,
                    _llm_checkpoint_id=record.llm_checkpoint_id,
                )
            elif data["t"] == "regenerate":
                await self.snapshot(username, session_id, data["message_id"])
                payload.update(
                    await self.chat.prepare_regenerate_message_payload(username, data)
                )
            stream = await self.chat.build_chat_stream(username, payload)
            run_id = next(iter(self.chat.chat_runs_by_session[session_id]))
            return stream, run_id

    async def resume(self, username, run_id):
        """Return an owned active run snapshot; completed runs are loaded from history."""
        try:
            return await self.chat.build_chat_run_stream(username, run_id)
        except ChatServiceError as exc:
            raise ApiError("Chat run is unavailable", status_code=404) from exc

    async def turn(self, username, session_id, message_id):
        """Resolve display and model records for one owned checkpointed turn."""
        session = await self.require_owned(username, session_id)
        rows = await self.chat.get_sorted_platform_history(session)
        target = next((row for row in rows if row.id == message_id), None)
        if not target:
            raise ApiError("Message not found", status_code=404)
        cid, history = await self.chat.load_current_conversation_history(session)
        cp = target.llm_checkpoint_id
        span = find_turn_range(history, cp) if cp else None
        linked = [row for row in rows if row.llm_checkpoint_id == cp]
        user = next((row for row in linked if row.content.get("type") == "user"), None)
        if not user:
            raise ApiError("Linked user message not found", status_code=409)
        if cid and cp and span is None:
            # A failed edit/regeneration may leave only the new display user record.
            # Archived versions must remain recoverable even without a new checkpoint.
            latest_user = next(
                (row for row in reversed(rows) if row.content.get("type") == "user"),
                None,
            )
            await self.ensure_schema()
            async with self.db.engine.connect() as conn:
                archived = (
                    await conn.execute(
                        select(versions.c.id)
                        .where(
                            versions.c.session_id == session_id,
                            versions.c.creator == username,
                            versions.c.user_message_id == user.id,
                        )
                        .limit(1)
                    )
                ).scalar_one_or_none()
            if archived and latest_user.id == user.id:
                span = (len(history), len(history) - 1)
        if not cid or span is None:
            raise ApiError(
                "This message has no linked model context; start a new chat turn",
                status_code=409,
            )
        return session, rows, cid, history, span, linked, user

    async def snapshot(self, username, session_id, message_id):
        """Persist an immutable turn snapshot once, including the model's true context."""
        state = await self.turn(username, session_id, message_id)
        _, _, _, history, (start, end), linked, user = state
        if start > end:
            return None, state
        value = {
            "checkpoint_id": user.llm_checkpoint_id,
            "records": [
                {
                    "content": row.content,
                    "sender_id": row.sender_id,
                    "sender_name": row.sender_name,
                }
                for row in linked
            ],
            "history": history[start : end + 1],
        }
        fingerprint = hashlib.sha256(
            json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        await self.ensure_schema()
        async with self.db.engine.begin() as conn:
            query = select(versions.c.id).where(
                versions.c.session_id == session_id,
                versions.c.creator == username,
                versions.c.user_message_id == user.id,
                versions.c.fingerprint == fingerprint,
            )
            vid = (await conn.execute(query)).scalar_one_or_none()
            if not vid:
                vid = str(uuid4())
                await conn.execute(
                    insert(versions).values(
                        id=vid,
                        session_id=session_id,
                        creator=username,
                        user_message_id=user.id,
                        fingerprint=fingerprint,
                        created_at=datetime.now(timezone.utc).isoformat(),
                        snapshot=value,
                    )
                )
        return vid, state

    async def list_versions(self, username, session_id, message_id):
        """Return saved response versions without exposing internal model/tool context."""
        async with self.locks[session_id]:
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Wait for the active response", status_code=409)
            current, state = await self.snapshot(username, session_id, message_id)
            user = state[-1]
            async with self.db.engine.connect() as conn:
                rows = (
                    (
                        await conn.execute(
                            select(versions)
                            .where(
                                versions.c.session_id == session_id,
                                versions.c.creator == username,
                                versions.c.user_message_id == user.id,
                            )
                            .order_by(versions.c.created_at)
                        )
                    )
                    .mappings()
                    .all()
                )
            return {
                "user_message_id": user.id,
                "can_select": state[4][0] > state[4][1]
                or is_latest_checkpoint(state[3], user.llm_checkpoint_id),
                "versions": [
                    {
                        "id": row["id"],
                        "created_at": row["created_at"],
                        "current": row["id"] == current,
                        "messages": [
                            entry["content"] for entry in row["snapshot"]["records"]
                        ],
                    }
                    for row in rows
                ],
            }

    async def select_version(self, username, session_id, message_id, version_id):
        """Atomically restore the latest turn's visible messages and model context."""
        async with self.locks[session_id]:
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Wait for the active response", status_code=409)
            _, state = await self.snapshot(username, session_id, message_id)
            session, _, cid, history, (start, end), linked, user = state
            if start <= end and not is_latest_checkpoint(
                history, user.llm_checkpoint_id
            ):
                raise ApiError(
                    "Branch an older turn before switching versions", status_code=409
                )
            async with self.db.engine.begin() as conn:
                row = (
                    (
                        await conn.execute(
                            select(versions).where(
                                versions.c.id == version_id,
                                versions.c.creator == username,
                                versions.c.session_id == session_id,
                                versions.c.user_message_id == user.id,
                            )
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if not row:
                    raise ApiError("Version not found", status_code=404)
                value = row["snapshot"]
                restored_user = next(
                    item
                    for item in value["records"]
                    if item["content"].get("type") == "user"
                )
                await conn.execute(
                    update(PlatformMessageHistory)
                    .where(PlatformMessageHistory.id == user.id)
                    .values(
                        content=restored_user["content"],
                        llm_checkpoint_id=value["checkpoint_id"],
                    )
                )
                await conn.execute(
                    delete(PlatformMessageHistory).where(
                        PlatformMessageHistory.id.in_(
                            [item.id for item in linked if item.id != user.id]
                        )
                    )
                )
                for entry in value["records"]:
                    if entry["content"].get("type") != "user":
                        await conn.execute(
                            insert(PlatformMessageHistory).values(
                                platform_id=session.platform_id,
                                user_id=session_id,
                                llm_checkpoint_id=value["checkpoint_id"],
                                **entry,
                            )
                        )
                await conn.execute(
                    update(ConversationV2)
                    .where(ConversationV2.conversation_id == cid)
                    .values(
                        content=history[:start] + value["history"] + history[end + 1 :],
                        token_usage=0,
                    )
                )
            return {"user_message_id": user.id, "version_id": version_id}

    async def delete_turn(self, username, session_id, message_id):
        """Delete the whole selected turn from display, model context and saved versions."""
        async with self.locks[session_id]:
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Wait for the active response", status_code=409)
            _, _, cid, history, (start, end), linked, user = await self.turn(
                username, session_id, message_id
            )
            await self.ensure_schema()
            ids = [row.id for row in linked]
            async with self.db.engine.begin() as conn:
                await conn.execute(
                    delete(PlatformMessageHistory).where(
                        PlatformMessageHistory.id.in_(ids)
                    )
                )
                await conn.execute(
                    delete(versions).where(
                        versions.c.session_id == session_id,
                        versions.c.creator == username,
                        versions.c.user_message_id == user.id,
                    )
                )
                await conn.execute(
                    update(ConversationV2)
                    .where(ConversationV2.conversation_id == cid)
                    .values(content=history[:start] + history[end + 1 :], token_usage=0)
                )
            thread_ids = await self.db.delete_webchat_threads_by_parent_message_ids(
                session_id, ids
            )
            await self.chat.delete_threads_by_ids(thread_ids, username)
            return {"deleted_message_ids": ids}

    async def delete_version(self, username, session_id, message_id, version_id):
        """Delete an archived version while keeping the current turn intact."""
        async with self.locks[session_id]:
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Wait for the active response", status_code=409)
            current, state = await self.snapshot(username, session_id, message_id)
            if current == version_id:
                raise ApiError(
                    "Delete the whole turn to remove the active version",
                    status_code=409,
                )
            async with self.db.engine.begin() as conn:
                result = await conn.execute(
                    delete(versions).where(
                        versions.c.id == version_id,
                        versions.c.session_id == session_id,
                        versions.c.creator == username,
                        versions.c.user_message_id == state[-1].id,
                    )
                )
                if result.rowcount != 1:
                    raise ApiError("Version not found", status_code=404)
            return {"deleted_version_id": version_id}

    async def branch(self, username, session_id, message_id):
        """Clone a complete checkpoint into a normal independent session."""
        async with self.locks[session_id]:
            if self.chat.chat_runs_by_session.get(session_id):
                raise ApiError("Wait for the active response", status_code=409)
            session, rows, cid, history, (_, end), linked, _ = await self.turn(
                username, session_id, message_id
            )
            if not find_turn_range(history, linked[0].llm_checkpoint_id):
                raise ApiError(
                    "Restore a completed version before branching", status_code=409
                )
            if (
                next(row for row in linked if row.id == message_id).content.get("type")
                != "bot"
            ):
                raise ApiError("Choose an assistant response to branch")
            created = await self.chat.new_session(username, "webchat")
            new_id = created["session_id"]
            new_session = await self.db.get_platform_session_by_id(new_id)
            conversation = await self.chat.conv_mgr.get_conversation(
                build_webchat_unified_msg_origin(session), cid
            )
            await self.chat.conv_mgr.new_conversation(
                build_webchat_unified_msg_origin(new_session),
                platform_id="webchat",
                content=deepcopy(history[: end + 1]),
                title=conversation.title,
                persona_id=conversation.persona_id,
            )
            # Include the complete selected turn so tool calls and results remain paired.
            last_id = linked[-1].id
            for row in rows:
                await self.chat.platform_history_mgr.insert(
                    platform_id="webchat",
                    user_id=new_id,
                    sender_id=row.sender_id,
                    sender_name=row.sender_name,
                    content=deepcopy(row.content),
                    llm_checkpoint_id=row.llm_checkpoint_id,
                )
                if row.id == last_id:
                    break
            return {"session_id": new_id, "context_mode": "checkpoint"}
