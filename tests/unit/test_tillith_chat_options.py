import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.core.provider.provider import EmbeddingProvider, Provider
from astrbot.dashboard.api.tillith import router
from astrbot.dashboard.responses import ApiError, error
from astrbot.dashboard.services.api_key_service import ApiKeyService


@pytest.fixture
def options_app():
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")

    @app.exception_handler(ApiError)
    async def handle_error(_request, exc):
        return JSONResponse(error(exc.message), status_code=exc.status_code)

    configs = {
        "default": {"provider_settings": {"enable": True, "provider_pool": ["*"]}},
        "limited": {"provider_settings": {"enable": True, "provider_pool": ["chat-a"]}},
        "off": {"provider_settings": {"enable": False, "provider_pool": ["*"]}},
    }
    profiles = SimpleNamespace(
        list_profiles=lambda: {
            "info_list": [
                {"id": key, "name": key, "path": "private-config-path"}
                for key in configs
            ]
        },
        get_profile=lambda key: {
            "config": {**configs[key], "prompt": "private-prompt"}
        },
    )
    provider_configs = {
        key: {
            "id": key,
            "enable": key != "disabled",
            "name": key.upper(),
            "key": ["private-provider-key"],
            "api_base": "https://private-endpoint",
        }
        for key in ("chat-a", "chat-b", "disabled", "embedding", "failed")
    }
    instances = []
    for key in ("chat-a", "chat-b", "disabled", "embedding"):
        instance = Mock(spec=EmbeddingProvider if key == "embedding" else Provider)
        instance.provider_config = {"id": key}
        instance.get_model.return_value = key + "-model"
        instances.append(instance)
    manager = SimpleNamespace(
        provider_insts=instances,
        get_provider_config_by_id=lambda key, **_kwargs: provider_configs.get(key),
    )
    app.state.core_lifecycle = SimpleNamespace(provider_manager=manager)
    app.state.services = SimpleNamespace(config_profiles=profiles)
    chat_hash = ApiKeyService.hash_key("synthetic-chat-key")
    file_hash = ApiKeyService.hash_key("synthetic-file-key")

    async def get_key(key_hash):
        if key_hash == chat_hash:
            return SimpleNamespace(key_id="chat-key", scopes=["chat"])
        if key_hash == file_hash:
            return SimpleNamespace(key_id="file-key", scopes=["file"])
        return None

    app.state.db = SimpleNamespace(
        get_active_api_key_by_hash=get_key, touch_api_key=AsyncMock()
    )
    return app


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key,status", [(None, 401), ("invalid", 401), ("synthetic-file-key", 403)]
)
async def test_options_require_chat_scope(options_app, key, status):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=options_app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/v1/tillith/chat-options", headers={"X-API-Key": key} if key else {}
        )
    assert response.status_code == status


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config_id,expected",
    [("default", ["chat-a", "chat-b"]), ("limited", ["chat-a"]), ("off", [])],
)
async def test_options_filter_loaded_chat_models_and_never_return_secrets(
    options_app, config_id, expected
):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=options_app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/v1/tillith/chat-options",
            params={"config_id": config_id},
            headers={"X-API-Key": "synthetic-chat-key"},
        )
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) == {"configs", "providers", "default_config_id"}
    assert data["default_config_id"] == "default"
    assert [row["id"] for row in data["providers"]] == expected
    assert all(set(row) == {"id", "name"} for row in data["configs"])
    assert all(set(row) == {"id", "name", "model"} for row in data["providers"])
    assert "private-" not in json.dumps(data)
    for provider in options_app.state.core_lifecycle.provider_manager.provider_insts:
        if isinstance(provider, Provider):
            provider.get_models.assert_not_called()


@pytest.mark.asyncio
async def test_options_empty_setup_and_invalid_config(options_app):
    options_app.state.core_lifecycle.provider_manager.provider_insts = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=options_app),
        base_url="http://test",
        headers={"X-API-Key": "synthetic-chat-key"},
    ) as client:
        response = await client.get("/api/v1/tillith/chat-options")
        assert response.status_code == 200
        assert response.json()["data"]["providers"] == []
        assert response.json()["data"]["default_config_id"] == "default"
        for config_id in ("missing", ""):
            response = await client.get(
                "/api/v1/tillith/chat-options", params={"config_id": config_id}
            )
            assert response.status_code == 404
