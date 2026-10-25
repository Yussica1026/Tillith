"""Owned session labels and visible-message search for Tillith clients."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    MetaData,
    String,
    Table,
    and_,
    case,
    func,
    literal,
    or_,
    select,
)
from sqlalchemy.dialects.sqlite import insert

from astrbot.core.db import BaseDatabase
from astrbot.core.db.po import PlatformMessageHistory, PlatformSession
from astrbot.core.utils.datetime_utils import to_utc_isoformat
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.chat_service import ChatService, ChatServiceError

session_meta = Table(
    "tillith_session_meta",
    MetaData(),
    Column("session_id", String(100), primary_key=True),
    Column("creator", String, primary_key=True),
    Column("pinned", Boolean, nullable=False, default=False),
    Column("starred", Boolean, nullable=False, default=False),
    Column("archived", Boolean, nullable=False, default=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)


class TillithSessionService:
    """Use the core database and chat ownership boundary without upstream migrations."""

    def __init__(self, db: BaseDatabase, chat: ChatService) -> None:
        self.db = db
        self.chat = chat
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()

    async def ensure_schema(self) -> None:
        """Create only the Tillith table once per service instance."""
        if self._schema_ready:
            return
        async with self._schema_lock:
            if not self._schema_ready:
                async with self.db.engine.begin() as connection:
                    await connection.run_sync(
                        lambda sync: session_meta.create(sync, checkfirst=True)
                    )
                self._schema_ready = True

    async def require_owned(self, username: str, session_id: str) -> None:
        """Validate a live session using the existing chat service.

        Args:
            username: Identity supplied by ScopeDependency.
            session_id: Requested existing session.

        Raises:
            ApiError: If missing or inaccessible, without revealing its existence.
        """
        try:
            await self.chat.get_session(username, session_id, page=1, page_size=1)
        except ChatServiceError as exc:
            raise ApiError("Session not found", status_code=404) from exc

    async def list_meta(
        self, username: str, session_id: str | None, page: int, page_size: int
    ) -> dict:
        """Read metadata, including defaults, only through live owned sessions.

        Args:
            username: Authenticated owner.
            session_id: Optional specific session to validate and return.
            page: One-based result page.
            page_size: Maximum items on the page.

        Returns:
            Metadata items and bounded pagination information.
        """
        if session_id:
            await self.require_owned(username, session_id)
        await self.ensure_schema()
        sessions = PlatformSession.__table__
        meta = session_meta.c
        query = (
            select(
                sessions.c.session_id,
                sessions.c.creator,
                func.coalesce(meta.pinned, False).label("pinned"),
                func.coalesce(meta.starred, False).label("starred"),
                func.coalesce(meta.archived, False).label("archived"),
                func.coalesce(meta.updated_at, sessions.c.updated_at).label(
                    "updated_at"
                ),
            )
            .select_from(
                sessions.outerjoin(
                    session_meta,
                    and_(
                        meta.session_id == sessions.c.session_id,
                        meta.creator == sessions.c.creator,
                    ),
                )
            )
            .where(sessions.c.creator == username)
            .order_by(
                func.coalesce(meta.pinned, False).desc(),
                sessions.c.updated_at.desc(),
                sessions.c.session_id,
            )
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
        if session_id:
            query = query.where(sessions.c.session_id == session_id)
        async with self.db.get_db() as connection:
            rows = (await connection.execute(query)).mappings().all()
        return {
            "items": [
                {**row, "updated_at": to_utc_isoformat(row["updated_at"])}
                for row in rows[:page_size]
            ],
            "page": page,
            "page_size": page_size,
            "has_more": len(rows) > page_size,
        }

    async def patch_meta(self, username: str, session_id: str, changes: dict) -> dict:
        """Atomically change supplied flags without replacing omitted flags.

        Args:
            username: Authenticated owner, never accepted from a request body.
            session_id: Existing owned session.
            changes: Validated boolean fields to change.

        Returns:
            The persisted metadata for the session.

        Raises:
            ApiError: If the session disappeared during the operation.
        """
        await self.require_owned(username, session_id)
        await self.ensure_schema()
        sessions = PlatformSession.__table__
        now = datetime.now(timezone.utc)
        flags = {
            name: changes.get(name, False) for name in ("pinned", "starred", "archived")
        }
        statement = insert(session_meta).from_select(
            ["session_id", "creator", *flags, "updated_at"],
            select(
                sessions.c.session_id,
                sessions.c.creator,
                *(literal(value) for value in flags.values()),
                literal(now),
            ).where(
                sessions.c.session_id == session_id,
                sessions.c.creator == username,
            ),
        )
        statement = statement.on_conflict_do_update(
            index_elements=["session_id", "creator"],
            set_={**changes, "updated_at": now},
        )
        async with self.db.get_db() as connection, connection.begin():
            result = await connection.execute(statement)
            if result.rowcount != 1:
                raise ApiError("Session not found", status_code=404)
        result = await self.list_meta(username, session_id, 1, 1)
        if not result["items"]:
            raise ApiError("Session not found", status_code=404)
        return result["items"][0]

    async def search(
        self,
        username: str,
        q: str,
        role: str | None,
        session_id: str | None,
        page: int,
        page_size: int,
    ) -> dict:
        """Search full visible message text while excluding reasoning and tool data.

        Args:
            username: Authenticated owner.
            q: Literal, nonempty substring to match, not SQL wildcard syntax.
            role: Optional user or assistant role filter.
            session_id: Optional owned session filter.
            page: One-based result page.
            page_size: Maximum returned snippets.

        Returns:
            At most page_size snippets with message IDs and owning session labels.
        """
        if session_id:
            await self.require_owned(username, session_id)
        history = PlatformMessageHistory.__table__
        sessions = PlatformSession.__table__
        # Legacy rows may contain a JSON-encoded string instead of a JSON object.
        decoded = case(
            (
                func.json_type(history.c.content) == "text",
                func.json_extract(history.c.content, "$"),
            ),
            else_=history.c.content,
        )
        document = case((func.json_valid(decoded), decoded), else_="{}")
        parts = func.json_each(document, "$.message").table_valued("value", "type")
        part = case((parts.c.type == "object", parts.c.value), else_="{}")
        visible_text = (
            select(
                func.coalesce(
                    func.group_concat(func.json_extract(part, "$.text"), ""), ""
                )
            )
            .select_from(parts)
            .where(
                func.json_extract(part, "$.type") == "plain",
                func.json_type(part, "$.text") == "text",
            )
            .correlate(history)
            .scalar_subquery()
        )
        message_role = case(
            (
                or_(
                    history.c.sender_id == "bot",
                    history.c.sender_name == "bot",
                    func.json_extract(document, "$.type") == "bot",
                ),
                "assistant",
            ),
            else_="user",
        )
        query = (
            select(
                history.c.id.label("message_id"),
                sessions.c.session_id,
                sessions.c.display_name.label("session_title"),
                message_role.label("role"),
                visible_text.label("text"),
                history.c.created_at,
            )
            .select_from(
                history.join(
                    sessions,
                    and_(
                        history.c.user_id == sessions.c.session_id,
                        history.c.platform_id == sessions.c.platform_id,
                    ),
                )
            )
            .where(
                sessions.c.creator == username,
                func.instr(func.lower(visible_text), q.lower()) > 0,
                or_(
                    func.json_extract(document, "$.type").is_(None),
                    func.json_extract(document, "$.type").in_(["user", "bot"]),
                ),
            )
            .order_by(history.c.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
        if session_id:
            query = query.where(sessions.c.session_id == session_id)
        if role:
            query = query.where(message_role == role)
        async with self.db.get_db() as connection:
            rows = (await connection.execute(query)).mappings().all()
        items = []
        for row in rows[:page_size]:
            start = max(0, row["text"].lower().find(q.lower()) - 100)
            items.append(
                {
                    **row,
                    "message_id": str(row["message_id"]),
                    "session_title": row["session_title"] or "新的对话",
                    "text": ("…" if start else "")
                    + row["text"][start : start + 500]
                    + ("…" if start + 500 < len(row["text"]) else ""),
                    "created_at": to_utc_isoformat(row["created_at"]),
                }
            )
        return {
            "items": items,
            "page": page,
            "page_size": page_size,
            "has_more": len(rows) > page_size,
        }
