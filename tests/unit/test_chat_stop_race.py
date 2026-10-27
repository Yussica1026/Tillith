"""Stopping a newly queued WebChat run waits briefly for event registration."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from astrbot.dashboard.services.chat_service import ChatService, ChatServiceError


def service_for(owner="owner"):
    service = object.__new__(ChatService)
    service.db = SimpleNamespace(
        get_platform_session_by_id=AsyncMock(
            return_value=SimpleNamespace(
                creator=owner,
                platform_id="webchat",
                is_group=0,
                session_id="session",
            )
        )
    )
    service.chat_runs_by_session = {}
    return service


@pytest.mark.asyncio
async def test_stop_retries_until_new_run_event_is_registered(monkeypatch):
    service = service_for()
    service.chat_runs_by_session["session"] = {"run"}
    request_stop = Mock(side_effect=(0, 1))
    sleep = AsyncMock()
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.active_event_registry",
        SimpleNamespace(request_agent_stop_all=request_stop),
    )
    monkeypatch.setattr("astrbot.dashboard.services.chat_service.asyncio.sleep", sleep)

    assert await service.stop_session("owner", "session") == {"stopped_count": 1}
    assert request_stop.call_count == 2
    sleep.assert_awaited_once_with(0.05)


@pytest.mark.asyncio
async def test_stop_without_active_run_does_not_retry(monkeypatch):
    service = service_for()
    request_stop = Mock(return_value=0)
    sleep = AsyncMock()
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.active_event_registry",
        SimpleNamespace(request_agent_stop_all=request_stop),
    )
    monkeypatch.setattr("astrbot.dashboard.services.chat_service.asyncio.sleep", sleep)

    assert await service.stop_session("owner", "session") == {"stopped_count": 0}
    request_stop.assert_called_once()
    sleep.assert_not_awaited()


@pytest.mark.asyncio
async def test_stop_retry_exits_when_run_finishes(monkeypatch):
    service = service_for()
    service.chat_runs_by_session["session"] = {"run"}
    request_stop = Mock(return_value=0)

    async def finish_run(_delay):
        service.chat_runs_by_session.pop("session", None)

    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.active_event_registry",
        SimpleNamespace(request_agent_stop_all=request_stop),
    )
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.asyncio.sleep", finish_run
    )

    assert await service.stop_session("owner", "session") == {"stopped_count": 0}
    request_stop.assert_called_once()


@pytest.mark.asyncio
async def test_stop_rejects_foreign_session_before_registry_access(monkeypatch):
    service = service_for(owner="other")
    request_stop = Mock(return_value=1)
    monkeypatch.setattr(
        "astrbot.dashboard.services.chat_service.active_event_registry",
        SimpleNamespace(request_agent_stop_all=request_stop),
    )

    with pytest.raises(ChatServiceError, match="Permission denied"):
        await service.stop_session("owner", "session")
    request_stop.assert_not_called()
