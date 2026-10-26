"""Owned persona bindings, worldbooks and manual memories for Tillith chat."""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
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
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from astrbot.core.db.po import PlatformMessageHistory, PlatformSession
from astrbot.dashboard.responses import ApiError

metadata = MetaData()
persona_settings = Table(
    "tillith_persona_settings",
    metadata,
    Column("persona_id", String, primary_key=True),
    Column("creator", String, primary_key=True),
    Column("payload", JSON, nullable=False),
)
bindings = Table(
    "tillith_session_context",
    metadata,
    Column("session_id", String, primary_key=True),
    Column("creator", String, primary_key=True),
    Column("persona_id", String),
    Column("worldbook_ids", JSON, nullable=False),
    Column("memory_enabled", Boolean, nullable=False),
    Column("memory_tools_enabled", Boolean, nullable=False),
)
books = Table(
    "tillith_worldbooks",
    metadata,
    Column("id", String, primary_key=True),
    Column("creator", String, nullable=False, index=True),
    Column("payload", JSON, nullable=False),
)
entries = Table(
    "tillith_worldbook_entries",
    metadata,
    Column("id", String, primary_key=True),
    Column("book_id", String, nullable=False, index=True),
    Column("creator", String, nullable=False),
    Column("payload", JSON, nullable=False),
)
memories = Table(
    "tillith_memories",
    metadata,
    Column("id", String, primary_key=True),
    Column("creator", String, nullable=False, index=True),
    Column("persona_id", String, nullable=False),
    Column("source_message_id", Integer),
    Column("payload", JSON, nullable=False),
)
sources = Table(
    "tillith_context_sources",
    metadata,
    Column("run_id", String, primary_key=True),
    Column("checkpoint_id", String, nullable=False, index=True),
    Column("session_id", String, nullable=False, index=True),
    Column("creator", String, nullable=False),
    Column("payload", JSON, nullable=False),
)


def get_context_service(db):
    """Share schema and session locks between API calls and the built-in plugin."""
    if not hasattr(db, "_tillith_context_service"):
        db._tillith_context_service = TillithContextService(db)
    return db._tillith_context_service


def validate_keyword_pattern(pattern):
    """Accept a bounded regex subset without groups, alternation or nested repetition."""
    if len(pattern) > 200:
        raise ValueError("Keyword patterns may contain at most 200 characters")
    try:
        parsed = re._parser.parse(pattern, 0)
    except re.error as exc:
        raise ValueError("Invalid keyword regular expression") from exc
    repeats = 0
    atoms = {
        re._constants.LITERAL,
        re._constants.NOT_LITERAL,
        re._constants.IN,
        re._constants.ANY,
        re._constants.CATEGORY,
    }
    for op, value in parsed:
        if op in {re._constants.MAX_REPEAT, re._constants.MIN_REPEAT}:
            repeats += 1
            if repeats > 1 or len(value[2]) != 1 or value[2][0][0] not in atoms:
                raise ValueError(
                    "Regex supports at most one quantifier on a single character or character class"
                )
        elif op not in atoms | {re._constants.AT}:
            raise ValueError(
                "Regex groups, alternatives, lookarounds and backreferences are not supported"
            )


class TillithContextService:
    """Keep all additional personal context scoped to its authenticated chat identity."""

    def __init__(self, db):
        self.db = db
        self.schema_lock = asyncio.Lock()
        self.ready = False

    async def ensure_schema(self):
        """Create only the additional Tillith tables."""
        async with self.schema_lock:
            if not self.ready:
                async with self.db.engine.begin() as conn:
                    await conn.run_sync(metadata.create_all)
                self.ready = True

    async def owned_session(self, owner, session_id):
        """Require a live webchat session belonging to the caller."""
        session = await self.db.get_platform_session_by_id(session_id)
        if not session or session.creator != owner or session.platform_id != "webchat":
            raise ApiError("Session not found", status_code=404)
        return session

    async def persona_preferences(self, owner, persona_id, patch=None):
        """Read or merge owner preferences without renaming the core persona ID."""
        if not await self.db.get_persona_by_id(persona_id):
            raise ApiError("Persona not found", status_code=404)
        await self.ensure_schema()
        async with self.db.engine.begin() as conn:
            row = (
                await conn.execute(
                    select(persona_settings.c.payload).where(
                        persona_settings.c.creator == owner,
                        persona_settings.c.persona_id == persona_id,
                    )
                )
            ).scalar_one_or_none()
            value = {
                "display_name": "",
                "default_config_id": None,
                "default_provider_id": None,
                **(row or {}),
                **(patch or {}),
            }
            if patch is not None:
                statement = sqlite_insert(persona_settings).values(
                    persona_id=persona_id, creator=owner, payload=value
                )
                await conn.execute(
                    statement.on_conflict_do_update(
                        index_elements=[
                            persona_settings.c.persona_id,
                            persona_settings.c.creator,
                        ],
                        set_={"payload": value},
                    )
                )
        return {"persona_id": persona_id, **value}

    async def persona_sessions(self, owner, persona_id):
        """List only live owned sessions explicitly bound to the selected persona."""
        await self.ensure_schema()
        async with self.db.engine.connect() as conn:
            return (
                (
                    await conn.execute(
                        select(PlatformSession.session_id)
                        .join(
                            bindings,
                            bindings.c.session_id == PlatformSession.session_id,
                        )
                        .where(
                            PlatformSession.creator == owner,
                            PlatformSession.platform_id == "webchat",
                            bindings.c.creator == owner,
                            bindings.c.persona_id == persona_id,
                        )
                        .order_by(
                            PlatformSession.updated_at.desc(),
                            PlatformSession.inner_id.desc(),
                        )
                        .limit(1000)
                    )
                )
                .scalars()
                .all()
            )

    async def context(self, owner, session_id):
        """Read an owned session binding with explicit, conservative defaults."""
        await self.owned_session(owner, session_id)
        await self.ensure_schema()
        async with self.db.engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        select(bindings).where(
                            bindings.c.session_id == session_id,
                            bindings.c.creator == owner,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row:
            return {
                key: row[key]
                for key in (
                    "persona_id",
                    "worldbook_ids",
                    "memory_enabled",
                    "memory_tools_enabled",
                )
            }
        return {
            "persona_id": None,
            "worldbook_ids": [],
            "memory_enabled": False,
            "memory_tools_enabled": False,
        }

    async def set_context(self, owner, session_id, patch):
        """Persist a binding and use the core's existing per-session persona rule."""
        from astrbot.core import sp

        old = await self.context(owner, session_id)
        value = {**old, **patch}
        persona_id = value["persona_id"]
        if persona_id and not await self.db.get_persona_by_id(persona_id):
            raise ApiError("Persona not found", status_code=404)
        if persona_id != old["persona_id"]:
            async with self.db.engine.connect() as conn:
                has_history = (
                    await conn.execute(
                        select(PlatformMessageHistory.id)
                        .where(
                            PlatformMessageHistory.user_id == session_id,
                            PlatformMessageHistory.platform_id == "webchat",
                        )
                        .limit(1)
                    )
                ).scalar_one_or_none()
            if has_history:
                raise ApiError(
                    "Create a new session to change persona after chatting",
                    status_code=409,
                )
        async with self.db.engine.begin() as conn:
            if value["worldbook_ids"]:
                found = (
                    (
                        await conn.execute(
                            select(books.c.id).where(
                                books.c.creator == owner,
                                books.c.id.in_(value["worldbook_ids"]),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if set(found) != set(value["worldbook_ids"]):
                    raise ApiError("Worldbook not found", status_code=404)
            statement = sqlite_insert(bindings).values(
                session_id=session_id, creator=owner, **value
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[bindings.c.session_id, bindings.c.creator],
                    set_=value,
                )
            )
        umo = f"webchat:FriendMessage:webchat!{owner}!{session_id}"
        rules = await sp.get_async("umo", umo, "session_service_config", {}) or {}
        rules = {**rules}
        if persona_id:
            rules["persona_id"] = persona_id
        else:
            rules.pop("persona_id", None)
        await sp.put_async("umo", umo, "session_service_config", rules)
        return value

    async def list_books(self, owner):
        """Return owned books and entries in deterministic order."""
        await self.ensure_schema()
        async with self.db.engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        select(books)
                        .where(books.c.creator == owner)
                        .order_by(books.c.id)
                    )
                )
                .mappings()
                .all()
            )
            entry_rows = (
                (
                    await conn.execute(
                        select(entries)
                        .where(entries.c.creator == owner)
                        .order_by(entries.c.id)
                    )
                )
                .mappings()
                .all()
            )
        return [
            {
                "id": row["id"],
                **row["payload"],
                "entries": [
                    {"id": item["id"], **item["payload"]}
                    for item in entry_rows
                    if item["book_id"] == row["id"]
                ],
            }
            for row in rows
        ]

    async def save_book(self, owner, value, book_id=None):
        """Atomically replace a book's entries without accepting foreign entry identifiers."""
        await self.ensure_schema()
        value = deepcopy(value)
        incoming = value.pop("entries")
        async with self.db.engine.begin() as conn:
            if book_id:
                existing = (
                    await conn.execute(
                        select(books.c.id).where(
                            books.c.id == book_id, books.c.creator == owner
                        )
                    )
                ).scalar_one_or_none()
                if not existing:
                    raise ApiError("Worldbook not found", status_code=404)
                valid_ids = set(
                    (
                        await conn.execute(
                            select(entries.c.id).where(
                                entries.c.book_id == book_id, entries.c.creator == owner
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if any(
                    item.get("id") and item["id"] not in valid_ids for item in incoming
                ):
                    raise ApiError("Entry not found in this worldbook", status_code=404)
                await conn.execute(
                    update(books).where(books.c.id == book_id).values(payload=value)
                )
                await conn.execute(
                    delete(entries).where(
                        entries.c.book_id == book_id, entries.c.creator == owner
                    )
                )
            else:
                book_id = str(uuid4())
                await conn.execute(
                    insert(books).values(id=book_id, creator=owner, payload=value)
                )
            for item in incoming:
                entry_id = item.pop("id", None) or str(uuid4())
                await conn.execute(
                    insert(entries).values(
                        id=entry_id, creator=owner, book_id=book_id, payload=item
                    )
                )
        return next(
            book for book in await self.list_books(owner) if book["id"] == book_id
        )

    async def delete_book(self, owner, book_id):
        """Delete an owned book and remove it from that owner's active bindings."""
        await self.ensure_schema()
        async with self.db.engine.begin() as conn:
            result = await conn.execute(
                delete(books).where(books.c.id == book_id, books.c.creator == owner)
            )
            if result.rowcount != 1:
                raise ApiError("Worldbook not found", status_code=404)
            await conn.execute(
                delete(entries).where(
                    entries.c.book_id == book_id, entries.c.creator == owner
                )
            )
            rows = (
                (
                    await conn.execute(
                        select(bindings).where(bindings.c.creator == owner)
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                if book_id in row["worldbook_ids"]:
                    await conn.execute(
                        update(bindings)
                        .where(
                            bindings.c.session_id == row["session_id"],
                            bindings.c.creator == owner,
                        )
                        .values(
                            worldbook_ids=[
                                item for item in row["worldbook_ids"] if item != book_id
                            ]
                        )
                    )
        return {"id": book_id}

    async def list_memories(self, owner, persona_id=None, query="", trashed=False):
        """Search manual memories within one authenticated owner and optional persona."""
        await self.ensure_schema()
        statement = select(memories).where(memories.c.creator == owner)
        if persona_id is not None:
            statement = statement.where(memories.c.persona_id == persona_id)
        async with self.db.engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
        result = [
            {
                "id": row["id"],
                "persona_id": row["persona_id"],
                "source_message_id": row["source_message_id"],
                **row["payload"],
            }
            for row in rows
            if row["payload"]["trashed"] == trashed
            and (not query or query.casefold() in row["payload"]["text"].casefold())
        ]
        return sorted(
            result, key=lambda row: (not row["starred"], row["created_at"], row["id"])
        )

    async def save_memory(self, owner, patch, memory_id=None):
        """Create or edit an owned memory, validating any linked source message."""
        await self.ensure_schema()
        now = datetime.now(timezone.utc).isoformat()
        async with self.db.engine.begin() as conn:
            old = None
            if memory_id:
                old = (
                    (
                        await conn.execute(
                            select(memories).where(
                                memories.c.id == memory_id, memories.c.creator == owner
                            )
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                if not old:
                    raise ApiError("Memory not found", status_code=404)
            value = {
                **(
                    old["payload"]
                    if old
                    else {
                        "type": "note",
                        "starred": False,
                        "trashed": False,
                        "invalidated": False,
                        "created_at": now,
                    }
                ),
                **patch,
                "updated_at": now,
            }
            persona_id = value.pop("persona_id", old["persona_id"] if old else None)
            source_id = value.pop(
                "source_message_id", old["source_message_id"] if old else None
            )
            if not persona_id or (
                not old and not await self.db.get_persona_by_id(persona_id)
            ):
                raise ApiError("Persona not found", status_code=404)
            if old and "text" in patch:
                value["invalidated"] = False
                if "source_message_id" not in patch:
                    source_id = None
            if source_id is not None and (not old or "source_message_id" in patch):
                source = await self.db.get_platform_message_history_by_id(source_id)
                if not source or source.platform_id != "webchat":
                    raise ApiError("Source message not found", status_code=404)
                binding = await self.context(owner, source.user_id)
                if binding["persona_id"] != persona_id:
                    raise ApiError(
                        "Source message belongs to another persona", status_code=409
                    )
            if memory_id:
                await conn.execute(
                    update(memories)
                    .where(memories.c.id == memory_id, memories.c.creator == owner)
                    .values(
                        persona_id=persona_id,
                        source_message_id=source_id,
                        payload=value,
                    )
                )
            else:
                memory_id = str(uuid4())
                await conn.execute(
                    insert(memories).values(
                        id=memory_id,
                        creator=owner,
                        persona_id=persona_id,
                        source_message_id=source_id,
                        payload=value,
                    )
                )
        return {
            "id": memory_id,
            "persona_id": persona_id,
            "source_message_id": source_id,
            **value,
        }

    async def invalidate_sources(self, owner, message_ids, connection=None):
        """Exclude memories linked to modified/deleted messages from future recall."""
        if connection is None:
            await self.ensure_schema()
        if not message_ids:
            return

        @asynccontextmanager
        async def transaction():
            if connection is not None:
                yield connection
            else:
                async with self.db.engine.begin() as conn:
                    yield conn

        async with transaction() as conn:
            rows = (
                (
                    await conn.execute(
                        select(memories).where(
                            memories.c.creator == owner,
                            memories.c.source_message_id.in_(message_ids),
                        )
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                value = {
                    **row["payload"],
                    "invalidated": True,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                await conn.execute(
                    update(memories)
                    .where(memories.c.id == row["id"])
                    .values(payload=value)
                )

    async def copy_context(self, owner, source_session, target_session, checkpoints):
        """Copy a branch's binding and immutable source evidence to its new owner session."""
        value = await self.context(owner, source_session)
        await self.set_context(owner, target_session, value)
        evidence = await self.get_sources(owner, source_session)
        async with self.db.engine.begin() as conn:
            for item in evidence:
                if item["checkpoint_id"] not in checkpoints:
                    continue
                run_id = str(uuid4())
                await conn.execute(
                    insert(sources).values(
                        run_id=run_id,
                        checkpoint_id=item["checkpoint_id"],
                        session_id=target_session,
                        creator=owner,
                        payload={
                            **item,
                            "session_id": target_session,
                            "run_id": run_id,
                        },
                    )
                )

    async def get_sources(self, owner, session_id, checkpoint_id=None, run_id=None):
        """Return recorded injection evidence only to its live session owner."""
        await self.owned_session(owner, session_id)
        await self.ensure_schema()
        statement = select(sources.c.payload).where(
            sources.c.creator == owner, sources.c.session_id == session_id
        )
        if checkpoint_id:
            statement = statement.where(sources.c.checkpoint_id == checkpoint_id)
        if run_id:
            statement = statement.where(sources.c.run_id == run_id)
        async with self.db.engine.connect() as conn:
            return (
                (
                    await conn.execute(
                        statement.order_by(
                            sources.c.payload["created_at"].as_string().desc()
                        ).limit(100)
                    )
                )
                .scalars()
                .all()
            )

    async def inject(self, owner, session_id, run_id, checkpoint_id, req):
        """Apply activated entries and keyword memories to the real provider request.

        Args:
            owner: Authenticated sender verified against the webchat session.
            session_id: Existing owned webchat session.
            run_id: Current core generation identifier.
            checkpoint_id: Current model-history checkpoint identifier.
            req: Mutable core ProviderRequest at the existing request hook.

        Returns:
            The exact source evidence recorded for this request.
        """
        binding = await self.context(owner, session_id)
        selected_books = [
            book
            for book in await self.list_books(owner)
            if book["id"] in binding["worldbook_ids"] and book["enabled"]
        ]
        activated = []
        for book in selected_books:
            for item in book["entries"]:
                if not item["enabled"]:
                    continue
                parts = (
                    req.contexts[-item["scan_depth"] :] if item["scan_depth"] else []
                )
                text = "\n".join(
                    [
                        json.dumps(part.get("content", ""), ensure_ascii=False)
                        for part in parts
                    ]
                    + [req.prompt or ""]
                )[-8000:]
                match = item["always_active"]
                for keyword in item["keywords"]:
                    if item["regex"]:
                        match = (
                            match
                            or re.search(
                                keyword,
                                text,
                                flags=0 if item["case_sensitive"] else re.IGNORECASE,
                            )
                            is not None
                        )
                    else:
                        match = match or (
                            keyword in text
                            if item["case_sensitive"]
                            else keyword.casefold() in text.casefold()
                        )
                if match:
                    activated.append(
                        {"book_id": book["id"], "entry_id": item["id"], **item}
                    )
        activated.sort(
            key=lambda item: (-item["priority"], item["book_id"], item["entry_id"])
        )
        activated = activated[:50]
        prefix, suffix, before_history, after_history = [], [], [], []
        for item in activated:
            text = item["text"]
            if item["position"] == "before_system":
                prefix.append(text)
            elif item["position"] == "after_system":
                suffix.append(text)
            else:
                part = {"role": item["role"], "content": text, "_no_save": True}
                if item["position"] == "before_history":
                    before_history.append(part)
                else:
                    after_history.append(part)
        req.contexts = [*before_history, *req.contexts, *after_history]
        recalled = []
        if binding["memory_enabled"] and binding["persona_id"]:
            candidates = await self.list_memories(owner, binding["persona_id"])
            tokens = re.findall(
                r"[a-zA-Z0-9_]+|[\u3400-\u9fff]{1,2}", (req.prompt or "").casefold()
            )
            scored = [
                (sum(token in item["text"].casefold() for token in set(tokens)), item)
                for item in candidates
                if not item["invalidated"]
            ]
            recalled = [
                item
                for score, item in sorted(
                    scored,
                    key=lambda pair: (-pair[0], not pair[1]["starred"], pair[1]["id"]),
                )
                if score > 0
            ][:5]
            if recalled:
                suffix.append(
                    "# Recalled memories\n"
                    + "\n".join(item["text"] for item in recalled)
                )
        if prefix or suffix:
            req.system_prompt = "\n\n".join([*prefix, req.system_prompt or "", *suffix])
        evidence = {
            "session_id": session_id,
            "run_id": run_id,
            "checkpoint_id": checkpoint_id,
            "persona_id": binding["persona_id"],
            "worldbooks": [
                {
                    key: item[key]
                    for key in (
                        "book_id",
                        "entry_id",
                        "title",
                        "text",
                        "position",
                        "role",
                    )
                }
                for item in activated
            ],
            "memories": [
                {key: item[key] for key in ("id", "text", "type", "source_message_id")}
                for item in recalled
            ],
            "memory_tools_enabled": binding["memory_tools_enabled"],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        async with self.db.engine.begin() as conn:
            statement = sqlite_insert(sources).values(
                run_id=run_id,
                checkpoint_id=checkpoint_id,
                session_id=session_id,
                creator=owner,
                payload=evidence,
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[sources.c.run_id], set_={"payload": evidence}
                )
            )
        return evidence
