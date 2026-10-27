"""Immutable visible-message snapshots saved by Tillith users."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Column,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    delete,
    func,
    select,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from astrbot.core.utils.datetime_utils import to_utc_isoformat
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tillith_context import get_context_service


favorites = Table(
    "tillith_favorites",
    MetaData(),
    Column("id", String, primary_key=True),
    Column("creator", String, nullable=False, index=True),
    Column("source_message_id", Integer, nullable=False),
    Column("session_id", String, nullable=False, index=True),
    Column("persona_id", String),
    Column("role", String, nullable=False),
    Column("text", Text, nullable=False),
    Column("created_at", String, nullable=False),
    Column("snapshot", JSON, nullable=False),
    UniqueConstraint(
        "creator", "source_message_id", name="uix_tillith_favorite_source"
    ),
)


def get_favorite_service(db):
    """Reuse one schema lock per database instance."""
    if not hasattr(db, "_tillith_favorite_service"):
        db._tillith_favorite_service = TillithFavoriteService(db)
    return db._tillith_favorite_service


def _visible_snapshot(content, sender_id, sender_name):
    """Return only user-visible text and durable attachment references."""
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (TypeError, ValueError):
            content = None
    if not isinstance(content, dict):
        raise ApiError("Message is not available to favorite", status_code=409)

    message_type = content.get("type")
    if message_type == "user":
        role = "user"
    elif message_type == "bot":
        role = "assistant"
    elif message_type is None and (sender_id == "bot" or sender_name == "bot"):
        role = "assistant"
    elif message_type is None:
        role = "user"
    else:
        raise ApiError("Message is not available to favorite", status_code=409)

    parts = content.get("message")
    if not isinstance(parts, list):
        raise ApiError("Message is not available to favorite", status_code=409)
    text = "".join(
        part["text"]
        for part in parts
        if isinstance(part, dict)
        and part.get("type") == "plain"
        and isinstance(part.get("text"), str)
    )
    attachments = [
        {
            "id": str(part["attachment_id"]),
            "type": part["type"],
            "name": part.get("filename") or part.get("name") or "附件",
        }
        for part in parts
        if isinstance(part, dict)
        and part.get("attachment_id")
        and part.get("type") in {"image", "record", "file", "video"}
    ]
    if not text and not attachments:
        raise ApiError("Message is not available to favorite", status_code=409)
    return role, text, attachments


class TillithFavoriteService:
    """Create and query owner-scoped snapshots without retaining private traces."""

    def __init__(self, db):
        self.db = db
        self.schema_lock = asyncio.Lock()
        self.schema_ready = False

    async def ensure_schema(self):
        """Create only the isolated Tillith favorites table."""
        if self.schema_ready:
            return
        async with self.schema_lock:
            if not self.schema_ready:
                async with self.db.engine.begin() as conn:
                    await conn.run_sync(
                        lambda sync: favorites.create(sync, checkfirst=True)
                    )
                self.schema_ready = True

    async def create(self, owner, session_id, message_id):
        """Snapshot one persisted visible message after validating its owner."""
        context = get_context_service(self.db)
        session = await context.owned_session(owner, session_id)
        record = await self.db.get_platform_message_history_by_id(message_id)
        if (
            not record
            or record.platform_id != "webchat"
            or record.user_id != session_id
        ):
            raise ApiError("Message not found", status_code=404)
        role, text, attachments = _visible_snapshot(
            record.content, record.sender_id, record.sender_name
        )
        binding = await context.context(owner, session_id)
        now = datetime.now(timezone.utc).isoformat()
        snapshot = {
            "message_id": str(record.id),
            "session_id": session_id,
            "session_title": session.display_name or "新的对话",
            "persona_id": binding["persona_id"],
            "role": role,
            "text": text,
            "attachments": attachments,
            "message_created_at": to_utc_isoformat(record.created_at),
        }
        await self.ensure_schema()
        async with self.db.engine.begin() as conn:
            statement = sqlite_insert(favorites).values(
                id=str(uuid4()),
                creator=owner,
                source_message_id=record.id,
                session_id=session_id,
                persona_id=binding["persona_id"],
                role=role,
                text=text,
                created_at=now,
                snapshot=snapshot,
            )
            await conn.execute(
                statement.on_conflict_do_nothing(
                    index_elements=[favorites.c.creator, favorites.c.source_message_id]
                )
            )
            row = (
                (
                    await conn.execute(
                        select(favorites).where(
                            favorites.c.creator == owner,
                            favorites.c.source_message_id == record.id,
                        )
                    )
                )
                .mappings()
                .one()
            )
        return self._item(row)

    async def list(self, owner, query="", page=1, page_size=50):
        """Search saved visible text with bounded owner-scoped pagination."""
        await self.ensure_schema()
        statement = select(favorites).where(favorites.c.creator == owner)
        query = query.strip()
        if query:
            statement = statement.where(
                func.instr(func.lower(favorites.c.text), query.lower()) > 0
            )
        statement = (
            statement.order_by(favorites.c.created_at.desc(), favorites.c.id)
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
        async with self.db.engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        return {
            "items": [self._item(row) for row in rows[:page_size]],
            "page": page,
            "page_size": page_size,
            "has_more": len(rows) > page_size,
        }

    async def delete(self, owner, favorite_id):
        """Delete one favorite without touching its source message or attachment."""
        await self.ensure_schema()
        async with self.db.engine.begin() as conn:
            result = await conn.execute(
                delete(favorites).where(
                    favorites.c.id == favorite_id,
                    favorites.c.creator == owner,
                )
            )
        if result.rowcount != 1:
            raise ApiError("Favorite not found", status_code=404)
        return {"id": favorite_id}

    @staticmethod
    def _item(row):
        return {"id": row["id"], "created_at": row["created_at"], **row["snapshot"]}
