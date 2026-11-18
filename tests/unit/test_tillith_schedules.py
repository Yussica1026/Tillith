"""A real scheduler and disposable WebChat database, with synthetic messages."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.core.cron.manager import CronJobManager
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.dashboard.api.auth import AuthContext, ScopeDependency
from astrbot.dashboard.api.tillith_schedules import router
from astrbot.dashboard.responses import ApiError


@pytest_asyncio.fixture
async def scheduled(tmp_path):
    db = SQLiteDatabase(str(tmp_path / "synthetic.db"))
    await db.initialize()
    db.inited = True
    await db.create_platform_session("owner", session_id="owned")
    await db.create_platform_session("other", session_id="foreign")
    delivered = asyncio.Event()

    async def deliver(*args):
        delivered.set()
        return True

    ctx = SimpleNamespace(
        send_message=AsyncMock(side_effect=deliver),
        get_using_provider_async=AsyncMock(),
    )
    cron = CronJobManager(db)
    await cron.start(ctx)
    app = FastAPI()
    app.include_router(router)
    app.state.db = db
    app.state.services = SimpleNamespace(
        cron=SimpleNamespace(core_lifecycle=SimpleNamespace(cron_manager=cron))
    )
    auth = SimpleNamespace(name="owner")
    app.dependency_overrides[ScopeDependency("chat")] = lambda: AuthContext(
        auth.name, ["chat"]
    )

    @app.exception_handler(ApiError)
    async def handle(_req, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client:
            yield client, cron, ctx, auth, delivered
    finally:
        await cron.shutdown()
        await db.engine.dispose()


@pytest.mark.asyncio
async def test_one_shot_delivers_without_client_or_model(scheduled):
    client, cron, ctx, _, delivered = scheduled
    when = (datetime.now(timezone.utc) + timedelta(seconds=1.5)).isoformat()
    response = await client.post(
        "/tillith/schedules",
        json={
            "session_id": "owned",
            "kind": "message",
            "note": "fixture reminder",
            "at": when,
        },
    )
    assert response.status_code == 200
    job = response.json()["data"]
    assert job["at"] == when
    await asyncio.wait_for(delivered.wait(), timeout=6)
    address, chain = ctx.send_message.await_args.args
    assert (
        address.endswith("!owner!owned") and chain.chain[0].text == "fixture reminder"
    )
    ctx.get_using_provider_async.assert_not_called()
    # Allow the real one-shot executor to finish its bookkeeping before tearing down.
    for _ in range(100):
        if not await cron.db.get_cron_job(job["id"]):
            break
        await asyncio.sleep(0.02)
    assert not await cron.db.get_cron_job(job["id"])


@pytest.mark.asyncio
async def test_daily_timezone_visibility_and_cancellation(scheduled):
    client, cron, _, auth, _ = scheduled
    base = {
        "session_id": "owned",
        "kind": "wake",
        "note": "fixture",
        "daily": "07:15",
        "timezone": "Asia/Taipei",
    }
    path = "/tillith/schedules"
    for invalid in (
        {"daily": "24:01"},
        {"timezone": "Unknown/Zone"},
        {"at": "2050-01-01T00:00:00Z"},
    ):
        assert (await client.post(path, json={**base, **invalid})).status_code == 422
    assert (
        await client.post(path, json={**base, "session_id": "foreign"})
    ).status_code == 404
    response = await client.post(path, json=base)
    assert response.status_code == 200
    job_id = response.json()["data"]["id"]
    job = await cron.db.get_cron_job(job_id)
    assert job.cron_expression == "15 07 * * *" and job.timezone == "Asia/Taipei"
    assert len((await client.get(path)).json()["data"]["items"]) == 1
    auth.name = "other"
    assert (await client.get(path)).json()["data"]["items"] == []
    assert (await client.delete(path + "/" + job_id)).status_code == 404
    auth.name = "owner"
    assert (await client.delete(path + "/" + job_id)).status_code == 200
    assert not await cron.db.get_cron_job(job_id)


@pytest.mark.asyncio
async def test_wake_in_bound_session_discards_late_result(scheduled, monkeypatch):
    client, cron, ctx, _, _ = scheduled
    result = await client.post(
        "/tillith/schedules",
        json={
            "session_id": "owned",
            "kind": "wake",
            "note": "fixture question",
            "daily": "02:07",
        },
    )
    job = await cron.db.get_cron_job(result.json()["data"]["id"])
    provider = SimpleNamespace(
        text_chat=AsyncMock(
            return_value=SimpleNamespace(completion_text="fixture reply")
        )
    )
    ctx.get_using_provider_async.return_value = provider
    await cron._run_active_agent_job(job, datetime.now(timezone.utc))
    provider.text_chat.assert_awaited_once_with(
        prompt="fixture question", contexts=[], func_tool=None
    )
    assert ctx.send_message.await_args.args[1].chain[0].text == "fixture reply"
    ctx.send_message.reset_mock()
    from astrbot.dashboard.services.tillith_context import get_context_service

    binding = AsyncMock(
        side_effect=[
            {"persona_id": job.payload["persona_id"]},
            {"persona_id": "different"},
        ]
    )
    monkeypatch.setattr(get_context_service(cron.db), "context", binding)
    await cron._run_active_agent_job(job, datetime.now(timezone.utc))
    ctx.send_message.assert_not_called()
