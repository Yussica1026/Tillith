"""Tool audit records only paired runtime calls and never stores credentials."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.platform_message_history_mgr import PlatformMessageHistoryManager
from astrbot.core.workspace import API_KEY_USERNAME_PREFIX
from astrbot.dashboard.api.tillith_tool_audit import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.chat_service import ChatRunState, ChatService
from astrbot.dashboard.services.tillith_tool_audit import (
    TillithToolAuditService,
    redact_text,
)


@pytest_asyncio.fixture
async def audit_fixture(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "tool-audit.db"))
    await db.initialize()
    db.inited = True
    await db.create_platform_session(
        "owner", session_id="owned", display_name="Synthetic tools"
    )
    record = await PlatformMessageHistoryManager(db).insert(
        platform_id="webchat",
        user_id="owned",
        sender_id="owner",
        sender_name="owner",
        content={
            "type": "user",
            "message": [{"type": "plain", "text": "Use the synthetic tool"}],
        },
        llm_checkpoint_id="checkpoint",
    )
    service = TillithToolAuditService(db)
    yield db, service, record
    await db.engine.dispose()


@pytest.mark.asyncio
async def test_completed_call_is_searchable_and_credentials_are_redacted(audit_fixture):
    _db, service, source = audit_fixture
    created = await service.record_completed(
        creator="owner",
        session_id="owned",
        platform_id="webchat",
        checkpoint_id="checkpoint",
        run_id="run",
        call_id="call",
        tool="synthetic_lookup",
        args={
            "query": "weather",
            "headers": {"Authorization": "Bearer fixture-secret"},
            "url": "https://example.test/search?q=weather&api_key=fixture-key",
            "nested": [{"access_token": "fixture-token"}],
        },
        result=json.dumps(
            {
                "summary": "sunny",
                "password": "fixture-password",
                "link": "https://example.test/?token=fixture-result-token",
            }
        ),
        created_at=1_700_000_000,
    )
    assert created is not None
    assert created["message_id"] == str(source.id)
    assert created["session_title"] == "Synthetic tools"
    serialized = json.dumps(created, ensure_ascii=False)
    for secret in (
        "fixture-secret",
        "fixture-key",
        "fixture-token",
        "fixture-password",
        "fixture-result-token",
    ):
        assert secret not in serialized
    assert serialized.count("[REDACTED]") >= 5
    assert "fragment-secret" not in redact_text(
        'broken {"api_key":"fragment-secret" response'
    )
    assert (await service.list("owner", query="sunny"))["items"] == [created]
    assert (await service.list("stranger"))["items"] == []

    # A duplicated delivery cannot create or replace the original audit evidence.
    duplicated = await service.record_completed(
        creator="owner",
        session_id="owned",
        platform_id="webchat",
        checkpoint_id="checkpoint",
        run_id="run",
        call_id="call",
        tool="synthetic_lookup",
        args={"query": "changed"},
        result="changed",
    )
    assert duplicated == created


@pytest.mark.asyncio
async def test_chat_stream_audits_only_a_paired_tool_result(audit_fixture, monkeypatch):
    db, _service, _source = audit_fixture
    recorder = SimpleNamespace(record_completed=AsyncMock(return_value={}))
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.get_tool_audit_service",
        lambda _db: recorder,
    )
    chat = object.__new__(ChatService)
    chat.db = db
    chat.chat_runs = {}
    chat.chat_runs_by_session = {}
    chat.running_convs = {}
    chat.save_bot_message = AsyncMock(return_value=None)
    queue = asyncio.Queue()
    frames = (
        {
            "type": "plain",
            "data": json.dumps({"id": "orphan", "result": "ignored"}),
            "chain_type": "tool_call_result",
        },
        {
            "type": "plain",
            "data": json.dumps(
                {
                    "id": "interrupted",
                    "name": "never_completed",
                    "args": {"value": 1},
                }
            ),
            "chain_type": "tool_call",
        },
        {
            "type": "plain",
            "data": json.dumps(
                {
                    "id": "paired",
                    "name": "synthetic_lookup",
                    "args": {"value": 2},
                    "ts": 1_700_000_000,
                }
            ),
            "chain_type": "tool_call",
        },
        {
            "type": "plain",
            "data": json.dumps({"id": "paired", "result": "done"}),
            "chain_type": "tool_call_result",
        },
        {"type": "end", "data": ""},
    )
    for frame in frames:
        queue.put_nowait({**frame, "streaming": False, "message_id": "run"})
    run = ChatRunState(
        run_id="run",
        username="owner",
        session_id="owned",
        llm_checkpoint_id="checkpoint",
        platform_history_id="webchat",
        back_queue=queue,
    )
    chat.chat_runs["run"] = run
    chat.chat_runs_by_session["owned"] = {"run"}
    await chat._consume_chat_run(run)
    recorder.record_completed.assert_awaited_once()
    assert recorder.record_completed.await_args.kwargs["call_id"] == "paired"
    assert recorder.record_completed.await_args.kwargs["tool"] == "synthetic_lookup"


@pytest.mark.asyncio
async def test_rest_route_requires_chat_scope_and_api_key_owner(audit_fixture):
    db, _service, _source = audit_fixture
    chat_key = await db.create_api_key(
        "chat", ApiKeyService.hash_key("chat-key"), "fixture", ["chat"], "test"
    )
    await db.create_api_key(
        "file", ApiKeyService.hash_key("file-key"), "fixture", ["file"], "test"
    )
    api_owner = f"{API_KEY_USERNAME_PREFIX}{chat_key.key_id}"
    await db.create_platform_session(api_owner, session_id="api-owned")
    await PlatformMessageHistoryManager(db).insert(
        platform_id="webchat",
        user_id="api-owned",
        sender_id=api_owner,
        sender_name=api_owner,
        content={"type": "user", "message": [{"type": "plain", "text": "run"}]},
        llm_checkpoint_id="api-checkpoint",
    )
    await TillithToolAuditService(db).record_completed(
        creator=api_owner,
        session_id="api-owned",
        platform_id="webchat",
        checkpoint_id="api-checkpoint",
        run_id="api-run",
        call_id="api-call",
        tool="api-tool",
        args={},
        result="ok",
    )
    app = FastAPI()
    app.include_router(router)
    app.state.db = db

    @app.exception_handler(ApiError)
    async def error_response(_request, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/tillith/tool-audit")).status_code == 401
        assert (
            await client.get("/tillith/tool-audit", headers={"X-API-Key": "file-key"})
        ).status_code == 403
        response = await client.get(
            "/tillith/tool-audit", headers={"X-API-Key": "chat-key"}
        )
        assert response.status_code == 200
        assert response.json()["data"]["items"][0]["tool"] == "api-tool"
