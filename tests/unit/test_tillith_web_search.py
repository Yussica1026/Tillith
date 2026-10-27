"""Tillith web search settings never expose or overwrite unrelated credentials."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from astrbot.dashboard.api.tillith_web_search import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.tillith_web_search import TillithWebSearchService


@pytest.fixture
def web_search_fixture():
    configs = {
        "default": {
            "provider_settings": {
                "web_search": True,
                "websearch_provider": "tavily",
                "web_search_link": True,
                "websearch_tavily_key": ["tavily-secret"],
                "websearch_anysearch_key": ["anysearch-secret"],
                "websearch_baidu_app_builder_key": "baidu-secret",
                "provider_pool": ["fixture-model"],
            },
            "unrelated": {"token": "unrelated-secret", "value": 42},
        },
        "secondary": {
            "provider_settings": {
                "web_search": False,
                "websearch_provider": "brave",
                "web_search_link": False,
                "websearch_brave_key": ["secondary-secret"],
            },
            "unrelated": {"value": 7},
        },
    }

    async def update_profile(profile_id, config, **kwargs):
        assert kwargs == {"allow_admin_id_change": False}
        configs[profile_id] = deepcopy(config)

    profiles = SimpleNamespace(
        list_profiles=lambda: {
            "info_list": [
                {"id": "default", "name": "默认配置", "path": "private-path"},
                {"id": "secondary", "name": "备用配置", "path": "private-path"},
            ]
        },
        get_profile=lambda profile_id: {"config": configs[profile_id]},
        update_profile=AsyncMock(side_effect=update_profile),
    )
    return configs, profiles, TillithWebSearchService(profiles)


def test_listing_contains_all_providers_but_never_returns_keys(web_search_fixture):
    _configs, _profiles, service = web_search_fixture
    result = service.listing()
    assert {item["id"] for item in result["providers"]} == {
        "serpapi",
        "deepseek",
        "tavily",
        "baidu_ai_search",
        "bocha",
        "brave",
        "firecrawl",
        "exa",
        "anysearch",
    }
    anysearch = next(item for item in result["providers"] if item["id"] == "anysearch")
    assert anysearch["anonymous"] is True
    default = next(item for item in result["profiles"] if item["id"] == "default")
    assert set(default["configured_providers"]) == {
        "tavily",
        "baidu_ai_search",
        "anysearch",
    }
    serialized = json.dumps(result, ensure_ascii=False)
    assert "-secret" not in serialized
    assert "private-path" not in serialized
    assert "unrelated" not in serialized


@pytest.mark.asyncio
async def test_blank_preserves_replacement_and_clear_are_explicit(web_search_fixture):
    configs, profiles, service = web_search_fixture
    original_secondary = deepcopy(configs["secondary"])
    original_unrelated = deepcopy(configs["default"]["unrelated"])

    await service.save(
        "default",
        enabled=False,
        provider="tavily",
        show_sources=False,
        api_key="   ",
        api_key_supplied=True,
    )
    assert configs["default"]["provider_settings"]["websearch_tavily_key"] == [
        "tavily-secret"
    ]
    assert configs["default"]["provider_settings"]["web_search"] is False

    await service.save(
        "default",
        enabled=True,
        provider="tavily",
        show_sources=True,
        api_key="replacement-one\nreplacement-two",
        api_key_supplied=True,
    )
    assert configs["default"]["provider_settings"]["websearch_tavily_key"] == [
        "replacement-one",
        "replacement-two",
    ]

    result = await service.save(
        "default",
        enabled=True,
        provider="tavily",
        show_sources=True,
        clear_key=True,
    )
    assert configs["default"]["provider_settings"]["websearch_tavily_key"] == []
    assert "tavily" not in result["configured_providers"]
    assert configs["default"]["provider_settings"]["websearch_anysearch_key"] == [
        "anysearch-secret"
    ]
    assert configs["default"]["unrelated"] == original_unrelated
    assert configs["secondary"] == original_secondary
    assert profiles.update_profile.await_count == 3

    with pytest.raises(ApiError, match="either"):
        await service.save(
            "default",
            enabled=True,
            provider="tavily",
            show_sources=True,
            api_key="replacement",
            api_key_supplied=True,
            clear_key=True,
        )


@pytest.mark.asyncio
async def test_routes_require_config_scope_and_return_only_sanitized_data(
    web_search_fixture,
):
    _configs, _profiles, service = web_search_fixture
    app = FastAPI()
    app.include_router(router)
    app.state.tillith_web_search = service
    keys = {
        ApiKeyService.hash_key("config-key"): SimpleNamespace(
            key_id="config", scopes=["config"]
        ),
        ApiKeyService.hash_key("chat-key"): SimpleNamespace(
            key_id="chat", scopes=["chat"]
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
        assert (await client.get("/tillith/web-search-profiles")).status_code == 401
        assert (
            await client.get(
                "/tillith/web-search-profiles",
                headers={"X-API-Key": "chat-key"},
            )
        ).status_code == 403
        response = await client.get(
            "/tillith/web-search-profiles",
            headers={"X-API-Key": "config-key"},
        )
        assert response.status_code == 200
        assert "-secret" not in response.text
        response = await client.put(
            "/tillith/web-search-profiles/default",
            headers={"X-API-Key": "config-key"},
            json={
                "enabled": True,
                "provider": "baidu_ai_search",
                "show_sources": True,
                "api_key": "new-baidu-key",
            },
        )
        assert response.status_code == 200
        assert response.json()["data"]["provider"] == "baidu_ai_search"
        assert "new-baidu-key" not in response.text
