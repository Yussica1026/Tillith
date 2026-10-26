"""Personal context uses owned SQLite rows and the real request-hook contract."""

from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.platform_message_history_mgr import PlatformMessageHistoryManager
from astrbot.dashboard.api.tillith_context import (
    ContextPatch,
    WorldbookWrite,
    require_chat,
    router,
)
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tillith_context import (
    TillithContextService,
    get_context_service,
    validate_keyword_pattern,
)


@pytest_asyncio.fixture
async def service(tmp_path, monkeypatch):
    import astrbot.core

    prefs = {}

    async def get(*keys):
        return prefs.get(tuple(keys[:-1]), keys[-1])

    async def put(*keys):
        prefs[tuple(keys[:-1])] = keys[-1]

    monkeypatch.setattr(
        astrbot.core, "sp", SimpleNamespace(get_async=get, put_async=put)
    )
    db = SQLiteDatabase(str(tmp_path / "context.db"))
    await db.initialize()
    db.inited = True
    await db.insert_persona("synthetic-a", "Synthetic persona A")
    await db.insert_persona("synthetic-b", "Synthetic persona B")
    await db.create_platform_session("owner", session_id="session")
    await db.create_platform_session("other", session_id="foreign")
    instance = get_context_service(db)
    yield instance
    await db.engine.dispose()


def book(**entry):
    return WorldbookWrite(
        name="Synthetic book",
        entries=[dict(text="Synthetic worldbook", keywords=["orchid"], **entry)],
    ).model_dump()


@pytest.mark.asyncio
async def test_binding_owner_and_persona_changes_are_enforced(service):
    await service.set_context("owner", "session", {"persona_id": "synthetic-a"})
    with pytest.raises(ApiError, match="Session not found"):
        await service.context("other", "session")
    await PlatformMessageHistoryManager(service.db).insert(
        platform_id="webchat",
        user_id="session",
        sender_id="owner",
        content={"type": "user", "message": [{"type": "plain", "text": "synthetic"}]},
        llm_checkpoint_id="cp-one",
    )
    with pytest.raises(ApiError, match="new session"):
        await service.set_context("owner", "session", {"persona_id": "synthetic-b"})
    assert (await TillithContextService(service.db).context("owner", "session"))[
        "persona_id"
    ] == "synthetic-a"


@pytest.mark.asyncio
async def test_worldbook_owned_ids_and_deletion_unbind(service):
    saved = await service.save_book("owner", book())
    await service.set_context("owner", "session", {"worldbook_ids": [saved["id"]]})
    assert await service.list_books("other") == []
    with pytest.raises(ApiError):
        await service.set_context("other", "foreign", {"worldbook_ids": [saved["id"]]})
    changed = book()
    changed["entries"][0]["id"] = "foreign-id"
    with pytest.raises(ApiError):
        await service.save_book("owner", changed, saved["id"])
    await service.delete_book("owner", saved["id"])
    assert (await service.context("owner", "session"))["worldbook_ids"] == []


@pytest.mark.asyncio
async def test_inject_uses_current_prompt_and_keeps_priority_and_sources(service):
    value = book(position="before_history", priority=20)
    value["entries"].append(
        {**value["entries"][0], "text": "Second priority", "priority": 10}
    )
    saved = await service.save_book("owner", value)
    await service.set_context(
        "owner",
        "session",
        {
            "persona_id": "synthetic-a",
            "worldbook_ids": [saved["id"]],
            "memory_enabled": True,
        },
    )
    memory = await service.save_memory(
        "owner", {"persona_id": "synthetic-a", "text": "orchid uses synthetic sunlight"}
    )
    await service.save_memory(
        "owner", {"persona_id": "synthetic-b", "text": "orchid other persona secret"}
    )
    await service.save_memory(
        "other", {"persona_id": "synthetic-a", "text": "orchid other identity secret"}
    )
    req = SimpleNamespace(
        prompt="orchid?",
        contexts=[{"role": "user", "content": "past"}],
        system_prompt="persona instruction",
    )
    evidence = await service.inject("owner", "session", "run-one", "cp-one", req)
    assert [p["content"] for p in req.contexts] == [
        "Synthetic worldbook",
        "Second priority",
        "past",
    ]
    assert all(p["_no_save"] for p in req.contexts[:2])
    assert "synthetic sunlight" in req.system_prompt
    assert "secret" not in req.system_prompt
    assert [m["id"] for m in evidence["memories"]] == [memory["id"]]
    assert (await service.get_sources("owner", "session", "cp-one"))[0] == evidence
    with pytest.raises(ApiError):
        await service.get_sources("other", "session")
    req = SimpleNamespace(prompt="unrelated", contexts=[], system_prompt="persona")
    evidence = await service.inject("owner", "session", "run-two", "cp-two", req)
    assert not evidence["worldbooks"] and not evidence["memories"]


@pytest.mark.asyncio
async def test_memory_source_invalidation_edit_and_trash_remain_usable(service):
    await service.set_context("owner", "session", {"persona_id": "synthetic-a"})
    source = await PlatformMessageHistoryManager(service.db).insert(
        platform_id="webchat",
        user_id="session",
        sender_id="owner",
        content={"type": "user", "message": []},
        llm_checkpoint_id="cp-one",
    )
    memory = await service.save_memory(
        "owner",
        {
            "persona_id": "synthetic-a",
            "text": "synthetic fact",
            "source_message_id": source.id,
        },
    )
    with pytest.raises(ApiError):
        await service.save_memory(
            "other",
            {
                "persona_id": "synthetic-a",
                "text": "foreign",
                "source_message_id": source.id,
            },
        )
    await service.invalidate_sources("owner", [source.id])
    assert (await service.list_memories("owner"))[0]["invalidated"]
    from sqlalchemy import delete

    from astrbot.core.db.po import PlatformMessageHistory

    async with service.db.engine.begin() as conn:
        await conn.execute(delete(PlatformMessageHistory))
    await service.save_memory("owner", {"trashed": True}, memory["id"])
    assert not await service.list_memories("owner")
    edited = await service.save_memory(
        "owner", {"text": "new manually confirmed fact", "trashed": False}, memory["id"]
    )
    assert not edited["invalidated"] and edited["source_message_id"] is None


@pytest.mark.asyncio
async def test_invalidation_participates_in_caller_transaction_rollback(service):
    memory = await service.save_memory(
        "owner", {"persona_id": "synthetic-a", "text": "synthetic"}
    )
    from sqlalchemy import update

    from astrbot.dashboard.services.tillith_context import memories

    async with service.db.engine.begin() as conn:
        await conn.execute(
            update(memories)
            .where(memories.c.id == memory["id"])
            .values(source_message_id=99)
        )
    with pytest.raises(RuntimeError):
        async with service.db.engine.begin() as conn:
            await service.invalidate_sources("owner", [99], conn)
            raise RuntimeError("synthetic rollback")
    assert not (await service.list_memories("owner"))[0]["invalidated"]


@pytest.mark.asyncio
async def test_preferences_keep_core_id_and_owner_separate(service):
    await service.persona_preferences(
        "owner",
        "synthetic-a",
        {"display_name": "Synthetic label", "default_provider_id": "local"},
    )
    assert (await service.persona_preferences("other", "synthetic-a"))[
        "display_name"
    ] == ""
    assert (
        await service.db.get_persona_by_id("synthetic-a")
    ).system_prompt == "Synthetic persona A"


@pytest.mark.parametrize("pattern", ["(a+)+$", "a*a*", "(a|aa)+", "(?=a)a", r"(a)\1"])
def test_unsafe_regex_rejected(pattern):
    with pytest.raises(ValueError):
        validate_keyword_pattern(pattern)


def test_bounded_regex_and_null_patch_contract():
    validate_keyword_pattern(r"orchid[0-9]+$")
    with pytest.raises(ValidationError):
        ContextPatch(memory_enabled=None)
    assert ContextPatch(persona_id=None).model_dump(exclude_unset=True) == {
        "persona_id": None
    }


@pytest.mark.asyncio
async def test_rest_import_export_preserves_values_without_foreign_ids(service):
    app = FastAPI()
    app.state.db = service.db
    app.dependency_overrides[require_chat] = lambda: SimpleNamespace(username="owner")
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def handle(_, exc):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.message})

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        made = (await client.post("/tillith/worldbooks", json=book())).json()["data"]
        export = (await client.get(f"/tillith/worldbooks/{made['id']}/export")).json()[
            "data"
        ]
        imported = (
            await client.post("/tillith/worldbooks/import", json=export)
        ).json()["data"]["worldbooks"][0]
        assert imported["entries"][0]["text"] == made["entries"][0]["text"]
        assert (
            imported["id"] != made["id"]
            and imported["entries"][0]["id"] != made["entries"][0]["id"]
        )
        options = (await client.get("/tillith/persona-options")).json()["data"]
        assert "system_prompt" not in str(options) and "Synthetic persona" not in str(
            options
        )
