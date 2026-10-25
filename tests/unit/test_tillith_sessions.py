"""Exercise Tillith session features against the real database and auth boundary."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import delete, update

from astrbot.core.db.po import PlatformMessageHistory, PlatformSession
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.platform_message_history_mgr import PlatformMessageHistoryManager
from astrbot.dashboard.api.tillith import router
from astrbot.dashboard.responses import ApiError, error
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.chat_service import ChatService


def make_app(db):
    """Build real routes with the existing chat ownership implementation."""
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.state.db = db
    chat = object.__new__(ChatService)
    chat.db = db
    chat.platform_history_mgr = PlatformMessageHistoryManager(db)
    chat.running_convs = {}
    chat.get_active_chat_runs = lambda _username, _session_id: []
    app.state.services = SimpleNamespace(chat=chat)

    @app.exception_handler(ApiError)
    async def handle_error(_request, exc):
        return JSONResponse(error(exc.message), status_code=exc.status_code)

    return app


@pytest_asyncio.fixture
async def storage(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "sessions.db"))
    await db.initialize()
    db.inited = True
    owners = {}
    for name, scopes in (
        ("one", ["chat"]),
        ("two", ["chat", "chat:admin"]),
        ("file", ["file"]),
    ):
        key = await db.create_api_key(
            name,
            ApiKeyService.hash_key("synthetic-" + name),
            "synthetic",
            scopes,
            "fixture",
        )
        owners[name] = "api_key:" + key.key_id
    for name, owner in (("first", "one"), ("second", "one"), ("other", "two")):
        await db.create_platform_session(
            owners[owner], session_id=name, display_name=name + " title"
        )
    messages = [
        (
            "first",
            "webchat",
            "user",
            {
                "type": "user",
                "message": [{"type": "plain", "text": "Find 中文 100%_literal"}],
            },
        ),
        (
            "first",
            "webchat",
            "bot",
            {
                "type": "bot",
                "message": [
                    {"type": "think", "think": "private-thought"},
                    {"type": "tool_call", "text": "private-tool"},
                    {"type": "plain", "text": "FIND "},
                    {"type": "plain", "text": "answer"},
                    {"type": "image", "url": "private-file"},
                ],
                "provider_key": "private-key",
            },
        ),
        (
            "second",
            "webchat",
            "bot",
            {
                "type": "bot",
                "message": [
                    {"type": "plain", "text": "x" * 900 + "find far away" + "z" * 900}
                ],
            },
        ),
        (
            "other",
            "webchat",
            "bot",
            {
                "type": "bot",
                "message": [{"type": "plain", "text": "find other-owner-private"}],
            },
        ),
        (
            "first",
            "other-platform",
            "bot",
            {
                "type": "bot",
                "message": [
                    {"type": "plain", "text": "find unrelated-platform-private"}
                ],
            },
        ),
        (
            "first",
            "webchat",
            "bot",
            {
                "type": "bot",
                "message": ["malformed", 42, None, {"type": "plain", "text": 123}],
            },
        ),
        (
            "second",
            "webchat",
            "bot",
            json.dumps(
                {"type": "bot", "message": [{"type": "plain", "text": "legacy-中文"}]}
            ),
        ),
    ]
    messages.extend(
        (
            "first",
            "webchat",
            "system",
            {
                "type": kind,
                "message": [{"type": "plain", "text": "private-system-tool"}],
            },
        )
        for kind in ("system", "tool")
    )
    async with db.get_db() as connection, connection.begin():
        connection.add_all(
            [
                PlatformMessageHistory(
                    user_id=sid, platform_id=platform, sender_id=sender, content=content
                )
                for sid, platform, sender, content in messages
            ]
        )
    app = make_app(db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"X-API-Key": "synthetic-one"},
    ) as client:
        yield db, app, client, owners
    await db.engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/tillith/session-meta", "/tillith/search?q=find"])
@pytest.mark.parametrize(
    "key,status", [("", 401), ("invalid", 401), ("synthetic-file", 403)]
)
async def test_auth_and_scope(storage, path, key, status):
    _, _, client, _ = storage
    response = await client.get("/api/v1" + path, headers={"X-API-Key": key})
    assert response.status_code == status


@pytest.mark.asyncio
async def test_metadata_defaults_partial_updates_order_and_pagination(storage):
    _, _, client, _ = storage
    initial = (await client.get("/api/v1/tillith/session-meta")).json()["data"]
    assert {item["session_id"] for item in initial["items"]} == {"first", "second"}
    assert all(
        not item[flag]
        for item in initial["items"]
        for flag in ("pinned", "starred", "archived")
    )
    for patch in (
        {"pinned": True, "starred": True},
        {"archived": True},
        {"starred": False},
    ):
        response = await client.patch(
            "/api/v1/tillith/session-meta", json={"session_id": "first", **patch}
        )
        assert response.status_code == 200
    saved = response.json()["data"]
    assert (saved["pinned"], saved["starred"], saved["archived"]) == (True, False, True)
    assert saved["updated_at"].endswith("Z") or "+00:00" in saved["updated_at"]
    first = (await client.get("/api/v1/tillith/session-meta?page_size=1")).json()[
        "data"
    ]
    second = (
        await client.get("/api/v1/tillith/session-meta?page_size=1&page=2")
    ).json()["data"]
    assert first["items"][0]["session_id"] == "first" and first["has_more"]
    assert second["items"][0]["session_id"] == "second" and not second["has_more"]


@pytest.mark.asyncio
@pytest.mark.parametrize("sid", ["other", "missing"])
async def test_foreign_or_missing_sessions_are_not_disclosed(storage, sid):
    _, _, client, _ = storage
    for path in (
        f"/tillith/session-meta?session_id={sid}",
        f"/tillith/search?q=find&session_id={sid}",
    ):
        response = await client.get("/api/v1" + path)
        assert response.status_code == 404
        assert response.json()["message"] == "Session not found"
    response = await client.patch(
        "/api/v1/tillith/session-meta", json={"session_id": sid, "pinned": True}
    )
    assert response.status_code == 404
    response = await client.get(
        "/api/v1/tillith/session-meta?session_id=first",
        headers={"X-API-Key": "synthetic-two"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"pinned": None},
        {"pinned": "false"},
        {"pinned": 1},
        {"creator": "other", "pinned": True},
    ],
)
async def test_flags_are_strict_and_creator_is_not_editable(storage, patch):
    _, _, client, _ = storage
    response = await client.patch(
        "/api/v1/tillith/session-meta", json={"session_id": "first", **patch}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_search_visible_text_unicode_literals_roles_and_pagination(storage):
    _, _, client, _ = storage
    result = (await client.get("/api/v1/tillith/search?q=find&page_size=2")).json()[
        "data"
    ]
    assert len(result["items"]) == 2 and result["has_more"]
    assert all(len(item["text"]) <= 502 for item in result["items"])
    assert "find far away" in result["items"][0]["text"]
    assert result["items"][1]["text"] == "FIND answer"
    last = (
        await client.get("/api/v1/tillith/search?q=find&page_size=2&page=2")
    ).json()["data"]
    assert len(last["items"]) == 1 and not last["has_more"]
    assert last["items"][0]["role"] == "user"
    for query, expected in (
        ("100%_", 1),
        ("中文", 2),
        ("legacy-中文", 1),
        ("private", 0),
        ("' OR 1=1--", 0),
    ):
        result = (
            await client.get("/api/v1/tillith/search", params={"q": query})
        ).json()["data"]
        assert len(result["items"]) == expected
    result = (
        await client.get(
            "/api/v1/tillith/search",
            params={"q": "find", "role": "assistant", "session_id": "first"},
        )
    ).json()["data"]
    assert len(result["items"]) == 1
    assert set(result["items"][0]) == {
        "message_id",
        "session_id",
        "session_title",
        "role",
        "text",
        "created_at",
    }
    assert "private" not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query,status",
    [
        ("q=", 422),
        ("q=%20", 400),
        ("q=x&role=system", 422),
        ("q=x&page=0", 422),
        ("q=x&page_size=51", 422),
        ("q=x&page=10001", 422),
    ],
)
async def test_search_rejects_unbounded_or_invalid_queries(storage, query, status):
    _, _, client, _ = storage
    assert (await client.get("/api/v1/tillith/search?" + query)).status_code == status


@pytest.mark.asyncio
async def test_deleted_sessions_and_reassigned_ids_do_not_expose_stale_rows(storage):
    db, _, client, owners = storage
    assert (
        await client.patch(
            "/api/v1/tillith/session-meta", json={"session_id": "first", "pinned": True}
        )
    ).status_code == 200
    async with db.get_db() as connection, connection.begin():
        await connection.execute(
            delete(PlatformSession).where(PlatformSession.session_id == "first")
        )
    for path in (
        "/tillith/session-meta?session_id=first",
        "/tillith/search?q=find&session_id=first",
    ):
        assert (await client.get("/api/v1" + path)).status_code == 404
    result = (await client.get("/api/v1/tillith/search?q=find")).json()["data"]
    assert all(item["session_id"] != "first" for item in result["items"])
    assert (
        await client.patch(
            "/api/v1/tillith/session-meta", json={"session_id": "first", "pinned": True}
        )
    ).status_code == 404
    await db.create_platform_session(owners["two"], session_id="first")
    result = (
        await client.get(
            "/api/v1/tillith/session-meta?session_id=first",
            headers={"X-API-Key": "synthetic-two"},
        )
    ).json()["data"]
    assert not result["items"][0]["pinned"]


@pytest.mark.asyncio
async def test_concurrent_partial_updates_and_fresh_database_connection(storage):
    db, app, client, owners = storage
    await client.get("/api/v1/tillith/session-meta")
    service = app.state.tillith_sessions
    await asyncio.gather(
        service.patch_meta(owners["one"], "first", {"pinned": True}),
        service.patch_meta(owners["one"], "first", {"starred": True}),
    )
    reopened = SQLiteDatabase(db.db_path)
    try:
        app2 = make_app(reopened)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app2),
            base_url="http://test",
            headers={"X-API-Key": "synthetic-one"},
        ) as fresh:
            result = (
                await fresh.get("/api/v1/tillith/session-meta?session_id=first")
            ).json()["data"]["items"][0]
            assert result["pinned"] and result["starred"] and not result["archived"]
            assert (await fresh.get("/api/v1/tillith/search?q=find")).json()["data"][
                "items"
            ]
    finally:
        await reopened.engine.dispose()


@pytest.mark.asyncio
async def test_delete_race_cannot_insert_metadata(storage):
    db, app, client, owners = storage
    await client.get("/api/v1/tillith/session-meta")
    service = app.state.tillith_sessions
    original = service.require_owned

    async def remove_after_validation(username, sid):
        await original(username, sid)
        async with db.get_db() as connection, connection.begin():
            await connection.execute(
                delete(PlatformSession).where(PlatformSession.session_id == sid)
            )

    service.require_owned = remove_after_validation
    with pytest.raises(ApiError) as caught:
        await service.patch_meta(owners["one"], "first", {"pinned": True})
    assert caught.value.status_code == 404


@pytest.mark.asyncio
async def test_search_immediately_reflects_message_edits_and_deletes(storage):
    db, _, client, _ = storage
    found = (
        await client.get("/api/v1/tillith/search", params={"q": "100%_literal"})
    ).json()["data"]["items"][0]
    message_id = int(found["message_id"])
    async with db.get_db() as connection, connection.begin():
        await connection.execute(
            update(PlatformMessageHistory)
            .where(PlatformMessageHistory.id == message_id)
            .values(
                content={
                    "type": "user",
                    "message": [{"type": "plain", "text": "edited-needle"}],
                }
            )
        )
    assert not (
        await client.get("/api/v1/tillith/search", params={"q": "100%_literal"})
    ).json()["data"]["items"]
    assert (await client.get("/api/v1/tillith/search?q=edited-needle")).json()["data"][
        "items"
    ][0]["message_id"] == str(message_id)
    async with db.get_db() as connection, connection.begin():
        await connection.execute(
            delete(PlatformMessageHistory).where(
                PlatformMessageHistory.id == message_id
            )
        )
    assert not (await client.get("/api/v1/tillith/search?q=edited-needle")).json()[
        "data"
    ]["items"]
