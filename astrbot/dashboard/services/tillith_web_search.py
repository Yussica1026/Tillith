"""Credential-safe access to per-profile web search settings."""

from __future__ import annotations

import asyncio
from copy import deepcopy

from astrbot.dashboard.responses import ApiError


SEARCH_PROVIDERS = {
    "serpapi": {
        "label": "SerpApi",
        "field": "websearch_serpapi_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "deepseek": {
        "label": "DeepSeek Search API",
        "field": "websearch_deepseek_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "tavily": {
        "label": "Tavily",
        "field": "websearch_tavily_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "baidu_ai_search": {
        "label": "Baidu AI Search",
        "field": "websearch_baidu_app_builder_key",
        "key_kind": "single",
        "anonymous": False,
    },
    "bocha": {
        "label": "Bocha",
        "field": "websearch_bocha_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "brave": {
        "label": "Brave",
        "field": "websearch_brave_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "firecrawl": {
        "label": "Firecrawl",
        "field": "websearch_firecrawl_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "exa": {
        "label": "Exa",
        "field": "websearch_exa_key",
        "key_kind": "multiple",
        "anonymous": False,
    },
    "anysearch": {
        "label": "AnySearch",
        "field": "websearch_anysearch_key",
        "key_kind": "multiple",
        "anonymous": True,
    },
}


def _configured(value) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(isinstance(item, str) and item.strip() for item in value)
    return bool(value)


class TillithWebSearchService:
    """Merge a narrow search patch into an existing server-side config profile."""

    def __init__(self, profiles):
        self.profiles = profiles
        self.lock = asyncio.Lock()

    @staticmethod
    def provider_metadata() -> list[dict]:
        """Return public provider labels without configuration or credentials."""
        return [
            {
                "id": provider_id,
                "label": value["label"],
                "key_kind": value["key_kind"],
                "anonymous": value["anonymous"],
            }
            for provider_id, value in SEARCH_PROVIDERS.items()
        ]

    def _profile_info(self, profile_id: str) -> tuple[dict, dict]:
        info = next(
            (
                item
                for item in self.profiles.list_profiles().get("info_list", [])
                if item.get("id") == profile_id
            ),
            None,
        )
        if not info:
            raise ApiError("Configuration not found", status_code=404)
        try:
            config = self.profiles.get_profile(profile_id)["config"]
        except (KeyError, ValueError) as exc:
            raise ApiError("Configuration not found", status_code=404) from exc
        if not isinstance(config, dict):
            raise ApiError("Configuration not found", status_code=404)
        return info, config

    @staticmethod
    def _public_profile(info: dict, config: dict) -> dict:
        settings = config.get("provider_settings")
        if not isinstance(settings, dict):
            settings = {}
        provider = settings.get("websearch_provider", "tavily")
        if provider not in SEARCH_PROVIDERS:
            provider = "tavily"
        return {
            "id": str(info["id"]),
            "name": str(info.get("name") or info["id"]),
            "enabled": settings.get("web_search") is True,
            "provider": provider,
            "show_sources": settings.get("web_search_link") is True,
            "configured_providers": [
                provider_id
                for provider_id, value in SEARCH_PROVIDERS.items()
                if _configured(settings.get(value["field"]))
            ],
        }

    def listing(self) -> dict:
        """List sanitized search settings for every configuration profile."""
        items = []
        for info in self.profiles.list_profiles().get("info_list", []):
            profile_id = info.get("id")
            if not isinstance(profile_id, str) or not profile_id:
                continue
            try:
                _, config = self._profile_info(profile_id)
            except ApiError:
                continue
            items.append(self._public_profile(info, config))
        return {"profiles": items, "providers": self.provider_metadata()}

    @staticmethod
    def _normalize_key(provider: str, value) -> str | list[str] | None:
        if value is None:
            return None
        if isinstance(value, str):
            values = [line.strip() for line in value.splitlines() if line.strip()]
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            values = [item.strip() for item in value if item.strip()]
        else:
            raise ApiError("API key must be text or a list of text values")
        if not values:
            return None
        if len(values) > 20 or any(len(item) > 4096 for item in values):
            raise ApiError("Too many or overly long API keys")
        if SEARCH_PROVIDERS[provider]["key_kind"] == "single":
            if len(values) != 1:
                raise ApiError("This search provider accepts one API key")
            return values[0]
        return values

    async def save(
        self,
        profile_id: str,
        *,
        enabled: bool,
        provider: str,
        show_sources: bool,
        api_key=None,
        api_key_supplied: bool = False,
        clear_key: bool = False,
    ) -> dict:
        """Update search fields only while retaining all unrelated server config."""
        if provider not in SEARCH_PROVIDERS:
            raise ApiError("Unknown search provider")
        if clear_key and api_key_supplied:
            raise ApiError("Choose either a replacement API key or clear_key")
        normalized_key = (
            self._normalize_key(provider, api_key) if api_key_supplied else None
        )
        async with self.lock:
            info, current = self._profile_info(profile_id)
            updated = deepcopy(current)
            settings = updated.setdefault("provider_settings", {})
            if not isinstance(settings, dict):
                settings = {}
                updated["provider_settings"] = settings
            settings["web_search"] = enabled
            settings["websearch_provider"] = provider
            settings["web_search_link"] = show_sources
            key_field = SEARCH_PROVIDERS[provider]["field"]
            if clear_key:
                settings[key_field] = (
                    "" if SEARCH_PROVIDERS[provider]["key_kind"] == "single" else []
                )
            elif normalized_key is not None:
                settings[key_field] = normalized_key
            try:
                await self.profiles.update_profile(
                    profile_id,
                    updated,
                    allow_admin_id_change=False,
                )
            except ApiError:
                raise
            except (KeyError, ValueError) as exc:
                raise ApiError("Search configuration could not be saved") from exc
            return self._public_profile(info, updated)
