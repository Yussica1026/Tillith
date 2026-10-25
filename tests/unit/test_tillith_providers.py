"""Credential privacy and update semantics at the mobile provider boundary."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.dashboard.api.tillith_providers import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.tillith_providers import TillithProviderService


@pytest.fixture
def adapter():
    source = {
        "id": "source",
        "type": "openai_chat_completion",
        "key": ["synthetic-secret"],
        "api_base": "https://example.invalid/v1",
        "password": "password-secret",
        "plugin_field": "metadata-secret",
        "custom_headers": {"Authorization": "Bearer header-secret"},
        "extra": {"access_token": "nested-secret"},
    }
    model = {
        "id": "model",
        "model": "synthetic-model",
        "provider_source_id": "source",
        "custom_extra_body": {"temperature": 0.5, "max_tokens": 128},
        "enable": True,
    }
    schema = {
        "provider": {
            "items": {
                "plugin_field": {
                    "type": "string",
                    "secret": True,
                    "default": "default-secret",
                }
            },
            "config_template": {"synthetic": deepcopy(source)},
        }
    }
    manager = SimpleNamespace(providers_config=[model])
    service = SimpleNamespace(
        provider_manager=manager,
        get_provider_schema=lambda: {
            "config_schema": deepcopy(schema),
            "providers": [model],
            "provider_sources": [source],
        },
        list_provider_sources=lambda: {"provider_sources": [deepcopy(source)]},
        get_provider_source=lambda _id: {"provider_source": deepcopy(source)},
        get_provider=lambda _id, merged=False: {"provider": deepcopy(model)},
        upsert_provider_source=AsyncMock(),
        update_provider=AsyncMock(),
        create_provider=AsyncMock(),
        delete_provider_source=AsyncMock(),
        delete_provider=AsyncMock(),
        set_provider_enabled=AsyncMock(),
        list_provider_source_models=AsyncMock(
            return_value={"models": ["synthetic-model"]}
        ),
        test_provider=AsyncMock(return_value={"status": "available", "error": None}),
    )
    return TillithProviderService(service)


def test_listing_schema_and_nested_credentials_never_echo_secrets(adapter):
    for result in (
        adapter.schema(),
        adapter.listing("source"),
        adapter.listing("provider"),
    ):
        assert "-secret" not in json.dumps(result)
    source = adapter.listing("source")["provider_sources"][0]
    assert set(source["secret_fields_present"]) == {
        "key",
        "password",
        "plugin_field",
        "custom_headers",
        "extra.access_token",
    }
    assert source["key"] == [] and source["custom_headers"] == {}
    assert source["api_base"] == "https://example.invalid/v1"
    model = adapter.listing("provider")["providers"][0]
    assert "key" not in model
    assert model["custom_extra_body"]["max_tokens"] == 128
    adapter.providers.test_provider.assert_not_called()
    adapter.providers.list_provider_source_models.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "  ", None, [], ["", "  "]])
async def test_blank_credentials_preserve_existing_values_while_other_fields_update(
    adapter, blank
):
    await adapter.save(
        "source",
        {
            "key": blank,
            "password": "",
            "custom_headers": {},
            "api_base": "https://new.invalid/v1",
        },
        "source",
    )
    saved = adapter.providers.upsert_provider_source.await_args.args[1]
    assert saved["key"] == ["synthetic-secret"]
    assert saved["password"] == "password-secret"
    assert saved["custom_headers"]["Authorization"] == "Bearer header-secret"
    assert saved["api_base"] == "https://new.invalid/v1"
    await adapter.save("provider", {"custom_extra_body": {"temperature": 0.9}}, "model")
    assert adapter.providers.update_provider.await_args.args[1][
        "custom_extra_body"
    ] == {"temperature": 0.9, "max_tokens": 128}


@pytest.mark.asyncio
async def test_explicit_replacement_and_credential_url_are_safe(adapter):
    await adapter.save("source", {"key": ["replacement"]}, "source")
    assert adapter.providers.upsert_provider_source.await_args.args[1]["key"] == [
        "replacement"
    ]
    for url in (
        "https://user:pass@example.invalid/v1",
        "https://example.invalid/v1?api_key=secret",
    ):
        public = adapter.redact({"api_base": url})
        assert public == {"api_base": "", "secret_fields_present": ["api_base"]}


@pytest.mark.asyncio
async def test_remote_actions_are_explicit_and_sdk_errors_are_not_echoed(adapter):
    adapter.providers.test_provider.return_value = {
        "status": "unavailable",
        "error": "401 raw API key synthetic-secret and request body",
    }
    result = await adapter.operation("provider", "test", "model")
    assert result["status"] == "unavailable" and "401" in result["error"]
    assert "synthetic-secret" not in json.dumps(result)
    adapter.providers.list_provider_source_models.assert_not_called()
    assert (await adapter.operation("source", "models", "source"))["models"] == [
        "synthetic-model"
    ]
    adapter.providers.upsert_provider_source.side_effect = ValueError(
        "secret raw error synthetic-secret"
    )
    with pytest.raises(ApiError) as captured:
        await adapter.save("source", {}, "source")
    assert "synthetic-secret" not in captured.value.message


@pytest.mark.asyncio
async def test_routes_require_provider_scope_not_chat_scope(adapter):
    app = FastAPI()
    app.include_router(router)
    app.state.tillith_providers = adapter
    keys = {
        ApiKeyService.hash_key("management"): SimpleNamespace(
            key_id="manager", scopes=["provider"]
        ),
        ApiKeyService.hash_key("chat-only"): SimpleNamespace(
            key_id="chat", scopes=["chat", "file"]
        ),
    }
    app.state.db = SimpleNamespace(
        get_active_api_key_by_hash=AsyncMock(side_effect=lambda value: keys.get(value)),
        touch_api_key=AsyncMock(),
    )

    @app.exception_handler(ApiError)
    async def on_error(_request, error):
        return JSONResponse({"message": error.message}, status_code=error.status_code)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://fixture"
    ) as client:
        assert (await client.get("/tillith/providers/schema")).status_code == 401
        assert (
            await client.get(
                "/tillith/providers/schema", headers={"X-API-Key": "chat-only"}
            )
        ).status_code == 403
        response = await client.get(
            "/tillith/provider-sources", headers={"X-API-Key": "management"}
        )
        assert response.status_code == 200 and "synthetic-secret" not in response.text
        response = await client.put(
            "/tillith/provider-sources/by-id?source_id=source",
            headers={"X-API-Key": "management"},
            json={"config": {"key": [], "api_base": "https://new.invalid/v1"}},
        )
        assert response.status_code == 200 and response.json()["data"] == {
            "id": "source"
        }
