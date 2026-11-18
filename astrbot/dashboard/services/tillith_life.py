"""Owner-scoped records voluntarily saved on this core."""

import asyncio
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)
from sqlalchemy import (
    Boolean,
    Column,
    Integer,
    MetaData,
    String,
    Table,
    and_,
    delete,
    exists,
    insert,
    or_,
    select,
    update,
)
from sqlalchemy import text as sql_text

from astrbot.core.db.po import Persona, PlatformSession
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tillith_context import bindings, get_context_service

Category = Literal[
    "board", "diary", "expense", "diet", "cycle", "daily", "memo", "anniversary"
]
EntryText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)
]
EntryDay = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]


class EntryBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("day", check_fields=False)
    @classmethod
    def valid_day(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value


class EntryWrite(EntryBase):
    category: Category
    text: EntryText
    day: EntryDay
    ai_visible: StrictBool = False
    parent_id: str | None = Field(default=None, min_length=1, max_length=100)


class EntryPatch(EntryBase):
    text: EntryText | None = None
    day: EntryDay | None = None
    ai_visible: StrictBool | None = None

    @model_validator(mode="after")
    def valid_changes(self):
        if not self.model_fields_set or any(
            getattr(self, key) is None for key in self.model_fields_set
        ):
            raise ValueError("Provide at least one non-null entry field")
        return self


metadata = MetaData()
life = Table(
    "tillith_life_entries",
    metadata,
    Column("id", String, primary_key=True),
    Column("owner", String, nullable=False, index=True),
    Column("persona_key", Integer, nullable=False, index=True),
    Column("category", String, nullable=False),
    Column("author", String, nullable=False),
    Column("text", String, nullable=False),
    Column("ai_visible", Boolean, nullable=False),
    Column("day", String, nullable=False),
    Column("parent_id", String, index=True),
    Column("created_at", String, nullable=False),
)
fields = (
    life.c.id,
    life.c.category,
    life.c.author,
    life.c.text,
    life.c.ai_visible,
    life.c.day,
    life.c.parent_id,
    life.c.created_at,
)


def get_life_service(db):
    """Share schema initialization between the API and the registered tools."""
    if not hasattr(db, "_tillith_life_service"):
        db._tillith_life_service = LifeService(db)
    return db._tillith_life_service


class LifeService:
    def __init__(self, db):
        self.db = db
        self.schema_lock = asyncio.Lock()
        self.ready = False

    @asynccontextmanager
    async def records(
        self, owner, persona_id, *, write=False, session_id=None, tool=None
    ):
        """Validate the current principal and persona in the record transaction.

        Args:
            owner: Authenticated username from the API or WebChat event.
            persona_id: Active persona ID; tool callers supply it from the run context.
            write: Acquire the SQLite writer lock before validating the parent and permissions.
            session_id: Actual WebChat session for a tool call.
            tool: Tool name requiring explicit selection on this persona.

        Yields:
            A database connection and the stored persona primary key.
        """
        async with self.schema_lock:
            if not self.ready:
                async with self.db.engine.begin() as conn:
                    await conn.run_sync(metadata.create_all)
                    await conn.execute(
                        sql_text(
                            "CREATE TRIGGER IF NOT EXISTS tillith_life_delete_persona "
                            "AFTER DELETE ON personas BEGIN DELETE FROM tillith_life_entries "
                            "WHERE persona_key = OLD.id; END"
                        )
                    )
                self.ready = True
        if tool:
            await get_context_service(self.db).ensure_schema()
        async with self.db.engine.begin() as conn:
            # SQLite's deferred BEGIN otherwise permits stale binding or parent reads.
            await conn.execute(sql_text("BEGIN IMMEDIATE" if write else "BEGIN"))
            query = select(Persona.id, Persona.tools).where(
                Persona.persona_id == persona_id
            )
            if tool:
                query = query.where(
                    exists().where(
                        PlatformSession.session_id == session_id,
                        PlatformSession.creator == owner,
                        PlatformSession.platform_id == "webchat",
                    ),
                    exists().where(
                        bindings.c.session_id == session_id,
                        bindings.c.creator == owner,
                        bindings.c.persona_id == persona_id,
                    ),
                )
            persona = (await conn.execute(query)).first()
            if persona is None or (tool and tool not in (persona.tools or [])):
                raise ApiError(
                    "Persona or tool authorization unavailable", 403 if tool else 404
                )
            yield conn, persona.id

    async def list_entries(self, owner, persona_id, *, session_id=None, category=None):
        tool = "tillith_life_read" if session_id is not None else None
        async with self.records(
            owner, persona_id, session_id=session_id, tool=tool
        ) as (conn, key):
            query = select(*fields).where(
                life.c.owner == owner, life.c.persona_key == key
            )
            if category:
                query = query.where(life.c.category == category)
            if tool:
                parent = life.alias("parent")
                query = query.where(
                    life.c.ai_visible.is_(True),
                    or_(
                        life.c.parent_id.is_(None),
                        exists().where(
                            parent.c.id == life.c.parent_id,
                            parent.c.persona_key == key,
                            parent.c.owner == owner,
                            parent.c.ai_visible.is_(True),
                        ),
                    ),
                ).limit(20)
            query = query.order_by(
                life.c.day.desc(), life.c.created_at.desc(), life.c.id.desc()
            )
            return [dict(row) for row in (await conn.execute(query)).mappings()]

    async def create(self, owner, persona_id, value: EntryWrite, *, session_id=None):
        tool = "tillith_life_write" if session_id is not None else None
        if value.category == "diary" and not value.ai_visible:
            raise ApiError("Private diaries must be kept on the device")
        async with self.records(
            owner, persona_id, write=True, session_id=session_id, tool=tool
        ) as (conn, key):
            if value.parent_id:
                parent = select(life.c.ai_visible).where(
                    life.c.owner == owner,
                    life.c.persona_key == key,
                    life.c.id == value.parent_id,
                    life.c.category == "board",
                    life.c.parent_id.is_(None),
                )
                visible = (await conn.execute(parent)).scalar_one_or_none()
                if (
                    value.category != "board"
                    or visible is None
                    or (tool and not visible)
                ):
                    raise ApiError("Parent board post unavailable", 404)
            record = {
                "id": str(uuid4()),
                "author": "ai" if tool else "user",
                "created_at": datetime.now(timezone.utc).isoformat(),
                **value.model_dump(),
            }
            await conn.execute(
                insert(life).values(owner=owner, persona_key=key, **record)
            )
            return record

    async def change(self, owner, persona_id, entry_id, patch: EntryPatch | None):
        async with self.records(owner, persona_id, write=True) as (conn, key):
            scope = and_(life.c.owner == owner, life.c.persona_key == key)
            target = and_(scope, life.c.id == entry_id)
            row = (
                (await conn.execute(select(*fields).where(target)))
                .mappings()
                .one_or_none()
            )
            if row is None:
                raise ApiError("Life entry not found", 404)
            if patch is None:
                await conn.execute(
                    delete(life).where(
                        scope, or_(life.c.id == entry_id, life.c.parent_id == entry_id)
                    )
                )
                return {}
            changes = patch.model_dump(exclude_unset=True)
            if row["author"] == "ai" and changes.keys() - {"ai_visible"}:
                raise ApiError("AI-authored text and date cannot be edited", 403)
            if row["category"] == "diary" and changes.get("ai_visible") is False:
                raise ApiError("Private diaries must be kept on the device")
            await conn.execute(update(life).where(target).values(**changes))
            return {**row, **changes}
