"""Favorite snapshots contain only durable visible message content."""

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import delete, update

from astrbot.core.db.po import PlatformMessageHistory
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.platform_message_history_mgr import PlatformMessageHistoryManager
from astrbot.core.workspace import API_KEY_USERNAME_PREFIX
from astrbot.dashboard.api.tillith_favorites import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.tillith_favorites import TillithFavoriteService


@pytest_asyncio.fixture
async def favorite_fixture(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "favorites.db"))
    await db.initialize()
    db.inited = True
    await db.create_platform_session(
        "owner", session_id="owned", display_name="Synthetic session"
    )
    await db.create_platform_session("other", session_id="foreign")
    record = await PlatformMessageHistoryManager(db).insert(
        platform_id="webchat",
        user_id="owned",
        sender_id="bot",
        content={
            "type": "bot",
            "message": [
                {"type": "think", "think": "private chain"},
                {"type": "plain", "text": "Visible synthetic answer"},
                {
                    "type": "file",
                    "attachment_id": "fixture-file",
                    "filename": "fixture.txt",
                },
                {
                    "type": "tool_call",
                    "name": "private-tool",
                    "args": {"key": "x"},
                },
            ],
            "reasoning": "private reasoning",
        },
        llm_checkpoint_id="checkpoint",
    )
    service = TillithFavoriteService(db)
    yield db, service, record
    await db.engine.dispose()


@pytest.mark.asyncio
async def test_snapshot_search_and_source_changes_leave_favorite_immutable(
    favorite_fixture,
):
    db, service, record = favorite_fixture
    created = await service.create("owner", "owned", record.id)
    assert created["text"] == "Visible synthetic answer"
    assert created["attachments"] == [
        {"id": "fixture-file", "type": "file", "name": "fixture.txt"}
    ]
    assert "private" not in str(created)

    async with db.engine.begin() as conn:
        await conn.execute(
            update(PlatformMessageHistory)
            .where(PlatformMessageHistory.id == record.id)
            .values(
                content={
                    "type": "bot",
                    "message": [{"type": "plain", "text": "Changed later"}],
                }
            )
        )
    # Creating the same favorite again is idempotent and cannot replace its snapshot.
    assert await service.create("owner", "owned", record.id) == created
    async with db.engine.begin() as conn:
        await conn.execute(
            delete(PlatformMessageHistory).where(
                PlatformMessageHistory.id == record.id
            )
        )
    assert (await service.list("owner", "synthetic"))["items"] == [created]
    assert (await service.list("owner", "Changed later"))["items"] == []


@pytest.mark.asyncio
async def test_create_rejects_foreign_missing_and_non_visible_messages(
    favorite_fixture,
):
    db, service, record = favorite_fixture
    with pytest.raises(ApiError, match="Session not found"):
        await service.create("owner", "foreign", record.id)
    with pytest.raises(ApiError, match="Message not found"):
        await service.create("owner", "owned", 99999)

    hidden = await PlatformMessageHistoryManager(db).insert(
        platform_id="webchat",
        user_id="owned",
        sender_id="bot",
        content={
            "type": "tool",
            "message": [{"type": "plain", "text": "hidden"}],
        },
    )
    with pytest.raises(ApiError, match="not available"):
        await service.create("owner", "owned", hidden.id)


@pytest.mark.asyncio
async def test_rest_routes_require_chat_scope_and_use_api_key_owner(
    favorite_fixture,
):
    db, _service, _record = favorite_fixture
    chat_key = await db.create_api_key(
        "chat", ApiKeyService.hash_key("chat-key"), "fixture", ["chat"], "test"
    )
    await db.create_api_key(
        "file", ApiKeyService.hash_key("file-key"), "fixture", ["file"], "test"
    )
    api_owner = f"{API_KEY_USERNAME_PREFIX}{chat_key.key_id}"
    await db.create_platform_session(api_owner, session_id="api-owned")
    api_record = await PlatformMessageHistoryManager(db).insert(
        platform_id="webchat",
        user_id="api-owned",
        sender_id="bot",
        content={
            "type": "bot",
            "message": [{"type": "plain", "text": "API fixture"}],
        },
    )
    app = FastAPI()
    app.include_router(router)
    app.state.db = db

    @app.exception_handler(ApiError)
    async def error_response(_request, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/tillith/favorites")).status_code == 401
        assert (
            await client.get(
                "/tillith/favorites", headers={"X-API-Key": "file-key"}
            )
        ).status_code == 403
        response = await client.post(
            "/tillith/favorites",
            headers={"X-API-Key": "chat-key"},
            json={"session_id": "api-owned", "message_id": api_record.id},
        )
        assert response.status_code == 200
        favorite_id = response.json()["data"]["id"]
        assert (
            await client.delete(
                f"/tillith/favorites/{favorite_id}",
                headers={"X-API-Key": "chat-key"},
            )
        ).status_code == 200
