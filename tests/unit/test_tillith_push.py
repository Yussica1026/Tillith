"""FCM enrollment and routing use synthetic accounts and an in-process transport."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.core.platform.sources.webchat import tillith_push as push
from astrbot.core.platform.sources.webchat import webchat_adapter as adapter
from astrbot.dashboard.api.auth import AuthContext, ScopeDependency
from astrbot.dashboard.api.tillith_devices import router
from astrbot.dashboard.responses import ApiError


@pytest.mark.asyncio
async def test_register_rotate_revoke_and_redact(tmp_path, monkeypatch):
    registry = tmp_path / "private" / "devices.sqlite"
    account = tmp_path / "fake-account"
    monkeypatch.setattr(push, "account_path", lambda: account)
    monkeypatch.setattr(push, "device_path", lambda: registry)
    app = FastAPI()
    app.include_router(router)
    user = AuthContext("owner", ["chat"])
    app.dependency_overrides[ScopeDependency("chat")] = lambda: user

    @app.exception_handler(ApiError)
    async def api_error(request, exc):
        return JSONResponse({"message": exc.message}, status_code=exc.status_code)

    device = str(uuid4())
    payload = {"token": "synthetic_device_token", "device_id": device, "owner": "owner"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        url = "/tillith/devices"
        assert (await client.post(url, json=payload)).status_code == 503
        account.touch()
        bad = await client.post(url, json={**payload, "device_id": "invalid"})
        assert bad.status_code == 400 and payload["token"] not in bad.text
        assert (
            await client.post(url, json={**payload, "owner": "other"})
        ).status_code == 400
        res = await client.post(url, json=payload)
        assert res.status_code == 200 and payload["token"] not in res.text
        token = "synthetic_rotated_token"
        assert (
            await client.post(url, json={**payload, "token": token})
        ).status_code == 200
        assert push._targets(registry, "owner") == [(device, token)]

        user = AuthContext("other", ["chat"])
        assert (await client.delete(f"{url}/{device}")).status_code == 200
        assert push._targets(registry, "owner") == [(device, token)]
        user = AuthContext("owner", ["chat"])
        assert (await client.delete(f"{url}/{device}")).status_code == 200
        assert (await client.delete(f"{url}/{device}")).status_code == 200
        assert push._targets(registry, "owner") == []


@pytest.mark.asyncio
async def test_server_resolves_owner_and_conditionally_removes_stale_tokens(tmp_path):
    path = tmp_path / "private" / "devices.sqlite"
    push.register_device(path, "first", "phone", "old")
    push.register_device(path, "other", "other-phone", "other-token")
    db = SimpleNamespace(get_platform_session_by_id=AsyncMock())
    db.get_platform_session_by_id.return_value = SimpleNamespace(
        platform_id="webchat", creator="first"
    )

    async def delivery(targets, session_id):
        assert targets == [("phone", "old")]
        assert session_id == "sid"
        push.register_device(path, "first", "phone", "new")
        return targets

    await push.notify_offline(db, "sid", path=path, sender=delivery)
    assert push._targets(path, "first") == [("phone", "new")]
    mock = AsyncMock(return_value=[("phone", "new")])
    await push.notify_offline(db, "sid", path=path, sender=mock)
    assert push._targets(path, "first") == []
    for row in (None, SimpleNamespace(platform_id="other-platform", creator="other")):
        db.get_platform_session_by_id.return_value = row
        await push.notify_offline(db, "sid", path=path, sender=mock)
    assert mock.await_count == 1
    assert push._targets(path, "other") == [("other-phone", "other-token")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requests", "saved", "notifications", "streamed"),
    [
        ([], True, 1, 0),
        ([], False, 0, 0),
        (["ws_sub_foreground"], True, 0, 1),
        (["ws_sub_foreground", "active-run"], True, 0, 1),
    ],
)
async def test_adapter_notifies_only_persisted_offline_messages(
    monkeypatch, requests, saved, notifications, streamed
):
    webchat = object.__new__(adapter.WebChatAdapter)
    webchat._webchat_queue_mgr = Mock()
    webchat._webchat_queue_mgr.list_back_request_ids.return_value = requests
    webchat._save_proactive_message = AsyncMock(return_value=saved)
    notify = AsyncMock()
    stream = AsyncMock()
    monkeypatch.setattr(adapter, "notify_offline", notify)
    monkeypatch.setattr(adapter.WebChatMessageEvent, "_send", stream)
    monkeypatch.setattr(adapter.Platform, "send_by_session", AsyncMock())
    await webchat.send_by_session(
        SimpleNamespace(session_id="webchat!owner!sid"), object()
    )
    assert notify.await_count == notifications
    assert stream.await_count == streamed
    if notifications:
        notify.assert_awaited_once_with(adapter.db_helper, "sid")


@pytest.mark.asyncio
async def test_fcm_v1_uses_minimal_data_and_handles_unregistered(tmp_path, monkeypatch):
    credentials = tmp_path / "synthetic.json"
    credentials.write_text(
        json.dumps(
            {
                "project_id": "fixture-project",
                "client_email": "example",
                "private_key": "fake",
            }
        )
    )
    monkeypatch.setattr(push, "account_path", lambda: credentials)
    monkeypatch.setattr(push.jwt, "encode", lambda *args, **kwargs: "signed-assertion")
    calls = []

    class Response:
        def __init__(self, status, data):
            self.status = status
            self.data = data

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def json(self):
            return self.data

    class Client(Response):
        def __init__(self, **kwargs):
            pass

        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            if len(calls) == 1:
                return Response(200, {"access_token": "access"})
            if len(calls) == 2:
                return Response(
                    404, {"error": {"details": [{"errorCode": "UNREGISTERED"}]}}
                )
            return Response(200, {})

    monkeypatch.setattr(push.aiohttp, "ClientSession", Client)
    result = await push.send_fcm(
        [("device1", "invalid"), ("device2", "valid")], "session-id"
    )
    assert result == [("device1", "invalid")]
    assert all(not options["allow_redirects"] for _, options in calls)
    assert (
        calls[2][0]
        == "https://fcm.googleapis.com/v1/projects/fixture-project/messages:send"
    )
    assert calls[2][1]["headers"] == {"Authorization": "Bearer access"}
    assert calls[2][1]["json"]["message"] == {
        "token": "valid",
        "android": {"priority": "HIGH", "ttl": "86400s"},
        "data": {"kind": "tillith.chat", "device": "device2", "session": "session-id"},
    }
