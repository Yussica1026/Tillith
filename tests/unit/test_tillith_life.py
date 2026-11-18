"""Shared life records enforce current WebChat ownership, persona and entry visibility."""

import json
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import insert, update

from astrbot.builtin_stars.tillith_life.main import READ, WRITE, Main
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.workspace import API_KEY_USERNAME_PREFIX
from astrbot.dashboard.api.tillith_life import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.tillith_context import bindings, get_context_service
from astrbot.dashboard.services.tillith_life import EntryWrite, get_life_service


@pytest_asyncio.fixture
async def fixture(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "records.db"))
    await db.initialize()
    db.inited = True
    await db.insert_persona("team/a", "Synthetic A", tools=[READ, WRITE])
    await db.insert_persona("b", "Synthetic B")
    key = await db.create_api_key(
        "chat", ApiKeyService.hash_key("test-key"), "fixture", ["chat"], "test"
    )
    await db.create_api_key(
        "file", ApiKeyService.hash_key("file-key"), "fixture", ["file"], "test"
    )
    owner = API_KEY_USERNAME_PREFIX + key.key_id
    await db.create_platform_session(owner, session_id="s")
    await get_context_service(db).ensure_schema()
    async with db.engine.begin() as conn:
        await conn.execute(
            insert(bindings).values(
                session_id="s",
                creator=owner,
                persona_id="team/a",
                worldbook_ids=[],
                memory_enabled=False,
                memory_tools_enabled=False,
            )
        )
    app = FastAPI()
    app.state.db = db
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def on_error(_req, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://fixture",
        headers={"X-API-Key": "test-key"},
    ) as client:
        yield db, owner, client
    await db.engine.dispose()


def draft(category="board", **extra):
    return {
        "category": category,
        "text": "Synthetic entry",
        "day": "2024-02-29",
        "ai_visible": False,
        **extra,
    }


@pytest.mark.asyncio
async def test_owned_crud_replies_and_private_diary_boundary(fixture):
    db, owner, client = fixture
    path = "/tillith/life/team%2Fa/entries"
    assert (
        await client.get(path, headers={"X-API-Key": "file-key"})
    ).status_code == 403
    assert (await client.post(path, json=draft("diary"))).status_code == 400
    assert (await client.post(path, json=draft(day="2025-02-29"))).status_code == 422
    assert (await client.post(path, json=draft(author="ai"))).status_code == 422
    response = await client.post(path, json=draft())
    assert response.status_code == 200, response.text
    post = response.json()["data"]
    assert set(post) == {
        "id",
        "text",
        "category",
        "day",
        "author",
        "ai_visible",
        "parent_id",
        "created_at",
    }
    reply = (
        await client.post(path, json=draft(parent_id=post["id"], ai_visible=True))
    ).json()["data"]
    assert reply["author"] == "user"
    assert (
        await client.post(path, json=draft(parent_id=reply["id"]))
    ).status_code == 404
    assert (
        await client.post("/tillith/life/b/entries", json=draft(parent_id=post["id"]))
    ).status_code == 404
    service = get_life_service(db)
    assert await service.list_entries("foreign", "team/a") == []
    assert await service.list_entries(owner, "team/a", session_id="s") == []
    changed = await client.patch(
        f"{path}/{post['id']}", json={"text": "Changed", "ai_visible": True}
    )
    assert changed.json()["data"]["text"] == "Changed"
    assert len(await service.list_entries(owner, "team/a", session_id="s")) == 2
    assert (await client.delete(f"{path}/{post['id']}")).status_code == 200
    assert (await client.get(path)).json()["data"]["items"] == []


@pytest.mark.asyncio
async def test_real_plugin_tools_pin_owner_persona_and_visibility_at_call(fixture):
    db, owner, client = fixture
    tools = {}
    Main(
        SimpleNamespace(
            add_llm_tools=lambda *registered: tools.update(
                {t.name: t for t in registered}
            )
        )
    )
    event = SimpleNamespace(
        get_sender_id=lambda: owner,
        get_platform_name=lambda: "webchat",
        session_id=f"webchat!{owner}!s",
        get_extra=lambda key: "team/a",
    )
    context = SimpleNamespace(
        context=SimpleNamespace(
            extra={"tool_persona_id": "team/a"},
            event=event,
            context=SimpleNamespace(get_db=lambda: db),
        )
    )
    path = "/tillith/life/team%2Fa/entries"
    hidden = (await client.post(path, json=draft())).json()["data"]
    assert "unavailable" in await tools[WRITE].call(
        context,
        category="board",
        day="2024-03-01",
        text="reply",
        parent_id=hidden["id"],
    )
    assert json.loads(await tools[READ].call(context)) == []
    result = json.loads(
        await tools[WRITE].call(
            context, category="diary", day="2024-03-01", text="Shared synthetic text"
        )
    )
    entry = json.loads(await tools[READ].call(context, category="diary"))[0]
    assert entry["id"] == result["id"] and entry["author"] == "ai"
    assert (
        await client.patch(f"{path}/{entry['id']}", json={"text": "overwrite"})
    ).status_code == 403
    assert (
        await client.patch(f"{path}/{entry['id']}", json={"ai_visible": False})
    ).status_code == 400
    await db.update_persona("team/a", tools=None)
    assert "authorization unavailable" in await tools[READ].call(context)
    await db.update_persona("team/a", tools=[READ, WRITE])
    context.context.extra["tool_persona_id"] = "b"
    assert "requires" in await tools[READ].call(context)
    context.context.extra["tool_persona_id"] = "team/a"
    async with db.engine.begin() as conn:
        await conn.execute(
            update(bindings).where(bindings.c.session_id == "s").values(persona_id="b")
        )
    assert "authorization unavailable" in await tools[WRITE].call(
        context, category="memo", day="2024-04-03", text="Late answer"
    )
    assert len((await client.get(path)).json()["data"]["items"]) == 2


@pytest.mark.asyncio
async def test_records_do_not_reappear_after_persona_recreation(fixture):
    db, owner, _client = fixture
    service = get_life_service(db)
    await service.create(owner, "b", EntryWrite(**draft("memo")))
    await db.delete_persona("b")
    await db.insert_persona("b", "Replacement")
    assert await service.list_entries(owner, "b") == []
