"""Checkpoint operations must keep visible and model histories consistent."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import event, select, update

from astrbot.core.db.po import ConversationV2, PlatformMessageHistory
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.platform_message_history_mgr import PlatformMessageHistoryManager
from astrbot.dashboard.api.tillith_messages import TillithChatCommand, router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.chat_service import ChatRunState, ChatService
from astrbot.dashboard.services.tillith_messages import TillithMessageService


@pytest_asyncio.fixture
async def service(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "messages.db"))
    await db.initialize()
    db.inited = True
    await db.create_platform_session("owner", session_id="session")
    chat = object.__new__(ChatService)
    chat.db = db
    chat.platform_history_mgr = PlatformMessageHistoryManager(db)
    chat.chat_runs = {}
    chat.chat_runs_by_session = {}
    chat.running_convs = {}
    chat.delete_threads_by_ids = AsyncMock()
    history = [
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "original"},
        {"role": "_checkpoint", "content": {"id": "cp-one"}},
    ]
    conversation = await db.create_conversation(
        user_id="test", platform_id="webchat", content=history
    )

    async def load_history(_session):
        async with db.engine.connect() as conn:
            content = (
                await conn.execute(
                    select(ConversationV2.content).where(
                        ConversationV2.conversation_id == conversation.conversation_id
                    )
                )
            ).scalar_one()
        return conversation.conversation_id, content

    chat.load_current_conversation_history = load_history
    for role, text in (("user", "question"), ("bot", "original")):
        await chat.platform_history_mgr.insert(
            platform_id="webchat",
            user_id="session",
            sender_id=role,
            content={"type": role, "message": [{"type": "plain", "text": text}]},
            llm_checkpoint_id="cp-one",
        )
    instance = TillithMessageService(db, chat, SimpleNamespace())
    yield instance
    await db.engine.dispose()


async def change_reply(service):
    """Represent a second completed model turn with a different checkpoint."""
    session = await service.require_owned("owner", "session")
    cid, history = await service.chat.load_current_conversation_history(session)
    history = deepcopy(history)
    history[1]["content"] = "changed"
    history[-1]["content"]["id"] = "cp-two"
    async with service.db.engine.begin() as conn:
        await conn.execute(
            update(ConversationV2)
            .where(ConversationV2.conversation_id == cid)
            .values(content=history)
        )
        await conn.execute(
            update(PlatformMessageHistory).values(llm_checkpoint_id="cp-two")
        )
        await conn.execute(
            update(PlatformMessageHistory)
            .where(PlatformMessageHistory.id == 2)
            .values(
                content={
                    "type": "bot",
                    "message": [{"type": "plain", "text": "changed"}],
                }
            )
        )


@pytest.mark.asyncio
async def test_versions_restore_both_histories_and_preserve_user_identity(service):
    first = await service.list_versions("owner", "session", 1)
    assert len(first["versions"]) == 1
    await change_reply(service)
    second = await service.list_versions("owner", "session", 2)
    assert len(second["versions"]) == 2
    assert len((await service.list_versions("owner", "session", 1))["versions"]) == 2
    await service.select_version("owner", "session", 1, first["versions"][0]["id"])
    state = await service.turn("owner", "session", 1)
    assert state[3][1]["content"] == "original"
    assert state[-1].id == 1
    assert state[-2][-1].content["message"][0]["text"] == "original"
    with pytest.raises(ApiError, match="active version"):
        await service.delete_version("owner", "session", 1, first["versions"][0]["id"])
    await service.delete_version("owner", "session", 1, second["versions"][-1]["id"])
    assert len((await service.list_versions("owner", "session", 1))["versions"]) == 1


@pytest.mark.asyncio
async def test_restore_rolls_back_display_changes_if_context_write_fails(service):
    first = await service.list_versions("owner", "session", 1)
    await change_reply(service)

    def reject_context_update(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith("UPDATE conversations"):
            raise RuntimeError("synthetic database failure")

    event.listen(
        service.db.engine.sync_engine, "before_cursor_execute", reject_context_update
    )
    try:
        with pytest.raises(RuntimeError, match="synthetic"):
            await service.select_version(
                "owner", "session", 1, first["versions"][0]["id"]
            )
    finally:
        event.remove(
            service.db.engine.sync_engine,
            "before_cursor_execute",
            reject_context_update,
        )
    state = await service.turn("owner", "session", 1)
    assert state[-1].llm_checkpoint_id == "cp-two"
    assert state[-2][-1].id == 2
    assert state[3][1]["content"] == "changed"


@pytest.mark.asyncio
async def test_owned_operations_and_busy_turn_are_rejected_without_mutation(service):
    with pytest.raises(ApiError, match="Session not found"):
        await service.list_versions("stranger", "session", 1)
    service.chat.chat_runs_by_session["session"] = {"running"}
    for operation in (service.list_versions, service.delete_turn, service.branch):
        with pytest.raises(ApiError, match="active response"):
            await operation("owner", "session", 1)
    service.chat.chat_runs_by_session.clear()
    result = await service.delete_turn("owner", "session", 2)
    assert result["deleted_message_ids"] == [1, 2]
    assert (await service.chat.load_current_conversation_history(None))[1] == []
    assert await service.db.get_platform_message_history_by_id(1) is None


def test_transport_rejects_internal_overrides_and_incomplete_edit():
    with pytest.raises(ValidationError):
        TillithChatCommand(
            t="send", session_id="session", message="test", _skip_user_history=True
        )
    with pytest.raises(ValidationError):
        TillithChatCommand(t="edit", session_id="session", message_id=1)
    assert TillithChatCommand(t="resume", run_id="run").run_id == "run"


@pytest.mark.asyncio
async def test_failed_regeneration_keeps_archived_version_recoverable(service):
    original = await service.list_versions("owner", "session", 1)
    async with service.db.engine.begin() as conn:
        await conn.execute(update(ConversationV2).values(content=[]))
        await conn.execute(
            update(PlatformMessageHistory).values(
                llm_checkpoint_id="failed-new-checkpoint"
            )
        )
    versions = await service.list_versions("owner", "session", 1)
    assert versions["can_select"]
    assert not any(item["current"] for item in versions["versions"])
    await service.select_version("owner", "session", 1, original["versions"][0]["id"])
    state = await service.turn("owner", "session", 1)
    assert state[3][1]["content"] == "original"
    assert state[-1].llm_checkpoint_id == "cp-one"


@pytest.mark.asyncio
async def test_rest_routes_enforce_existing_scope_and_session_ownership(service):
    app = FastAPI()
    app.include_router(router)
    app.state.db = service.db
    app.state.tillith_messages = service

    @app.exception_handler(ApiError)
    async def error_response(_request, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    await service.db.create_api_key(
        "file", ApiKeyService.hash_key("file-key"), "fixture", ["file"], "test"
    )
    await service.db.create_api_key(
        "other", ApiKeyService.hash_key("chat-key"), "fixture", ["chat"], "test"
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        path = "/tillith/sessions/session/messages/1/versions"
        assert (await client.get(path)).status_code == 401
        assert (
            await client.get(path, headers={"X-API-Key": "invalid"})
        ).status_code == 401
        assert (
            await client.get(path, headers={"X-API-Key": "file-key"})
        ).status_code == 403
        assert (
            await client.get(path, headers={"X-API-Key": "chat-key"})
        ).status_code == 404


@pytest.mark.asyncio
async def test_final_stream_events_survive_producer_completion(service, monkeypatch):
    """A slow subscriber must receive the final text and persistence receipt."""
    chat = service.chat
    chat.save_bot_message = AsyncMock(
        return_value=SimpleNamespace(id=3, created_at=None)
    )
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.to_utc_isoformat", lambda value: "test"
    )
    queue = asyncio.Queue()
    for frame in (
        {"type": "plain", "data": "last text", "streaming": True},
        {"type": "end"},
    ):
        queue.put_nowait(frame)
    run = ChatRunState(
        run_id="run",
        username="owner",
        session_id="session",
        llm_checkpoint_id="cp",
        platform_history_id="webchat",
        back_queue=queue,
    )
    chat.chat_runs["run"] = run
    chat.chat_runs_by_session["session"] = {"run"}
    stream = chat._subscribe_chat_run(run, include_snapshot=False)
    await chat._consume_chat_run(run)
    frames = [frame async for frame in stream]
    assert any("last text" in frame for frame in frames)
    assert any("message_saved" in frame for frame in frames)
    assert chat.save_bot_message.await_count == 1
