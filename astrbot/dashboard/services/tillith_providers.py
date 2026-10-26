"""Credential-safe mobile adapter for the existing provider configuration service."""

import asyncio
import re
from copy import deepcopy
from urllib.parse import parse_qsl, urlsplit

from astrbot.dashboard.responses import ApiError


class TillithProviderService:
    """Reuse provider loading and persistence without returning configured credentials."""

    def __init__(self, providers):
        self.providers = providers
        self.lock = asyncio.Lock()

    def secret_names(self):
        """Read secret flags from upstream and plugin-provided field metadata."""
        names = set()

        def visit(value):
            if isinstance(value, dict):
                for name, item in value.items():
                    if isinstance(item, dict) and item.get("secret") is True:
                        names.add(name.lower())
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)

        visit(self.providers.get_provider_schema()["config_schema"])
        return names

    @staticmethod
    def is_secret(name, names):
        """Recognize metadata fields and conventional credential/header names."""
        name = name.lower()
        return (
            name in names
            or name
            in {"key", "headers", "custom_headers", "authorization", "cookie", "auth"}
            or bool(
                re.search(
                    r"(?:api.?key|password|passwd|secret|credential|private.?key|access.?key|(?:^|_)token(?:$|_))",
                    name,
                )
            )
        )

    @classmethod
    def secret_url(cls, value, names):
        """Treat credential-bearing URLs as opaque fields rather than echoing them."""
        if not isinstance(value, str) or "://" not in value:
            return False
        try:
            parsed = urlsplit(value)
            return bool(
                parsed.username
                or parsed.password
                or any(cls.is_secret(key, names) for key, _ in parse_qsl(parsed.query))
            )
        except ValueError:
            return True

    def redact(self, config, names=None):
        """Return editable public fields plus paths of configured, write-only secrets."""
        names = self.secret_names() if names is None else names
        present = []

        def visit(value, path=""):
            if isinstance(value, dict):
                result = {}
                for key, item in value.items():
                    if key == "secret_fields_present":
                        continue
                    child = f"{path}.{key}" if path else key
                    if self.is_secret(key, names) or self.secret_url(item, names):
                        if item:
                            present.append(child)
                        result[key] = (
                            []
                            if isinstance(item, list)
                            else {}
                            if isinstance(item, dict)
                            else ""
                        )
                    else:
                        result[key] = visit(item, child)
                return result
            if isinstance(value, list):
                return [
                    visit(item, f"{path}.{index}") for index, item in enumerate(value)
                ]
            return deepcopy(value)

        result = visit(config)
        result["secret_fields_present"] = present
        return result

    def schema(self):
        """Return only definitions and blank credential templates, never live configs."""
        schema = deepcopy(self.providers.get_provider_schema()["config_schema"])
        names = self.secret_names()
        templates = schema.get("provider", {}).get("config_template", {})
        for key, value in templates.items():
            if isinstance(value, dict):
                templates[key] = self.redact(value, names)
                templates[key].pop("secret_fields_present", None)

        def clear_secret_defaults(value):
            if isinstance(value, dict):
                if value.get("secret") is True:
                    for field in ("default", "value", "example", "examples"):
                        if field in value:
                            value[field] = [] if isinstance(value[field], list) else ""
                for item in value.values():
                    clear_secret_defaults(item)
            elif isinstance(value, list):
                for item in value:
                    clear_secret_defaults(item)

        clear_secret_defaults(schema)
        return {"config_schema": schema}

    def listing(self, kind):
        """Read unmerged configurations so saving a model cannot copy source secrets."""
        names = self.secret_names()
        if kind == "source":
            values = self.providers.list_provider_sources()["provider_sources"]
            return {"provider_sources": [self.redact(value, names) for value in values]}
        values = self.providers.provider_manager.providers_config
        return {
            "providers": [
                self.redact(value, names)
                for value in values
                if value.get("provider_type") != "agent_runner"
            ]
        }

    def get_raw(self, kind, item_id):
        """Look up an existing domain configuration without exposing it to the caller."""
        try:
            if kind == "source":
                return self.providers.get_provider_source(item_id)["provider_source"]
            return self.providers.get_provider(item_id, merged=False)["provider"]
        except ValueError as exc:
            raise ApiError("Provider configuration not found", status_code=404) from exc

    async def save(self, kind, config, item_id=None, source_id=None):
        """Merge updates server-side, retaining any omitted or blank credentials.

        Args:
            kind: Source or model configuration.
            config: Explicit client fields with write-only credential values.
            item_id: Existing identifier for updates; absent for creation.
            source_id: Optional existing source for a new model.

        Returns:
            The saved identifier, without configuration or credentials.
        """
        names = self.secret_names()
        async with self.lock:
            old = self.get_raw(kind, item_id) if item_id else {}

            def merge(previous, incoming):
                result = deepcopy(previous)
                for key, value in incoming.items():
                    if key == "secret_fields_present":
                        continue
                    existing = previous.get(key)
                    secret = self.is_secret(key, names) or self.secret_url(
                        existing, names
                    )
                    blank = (
                        value is None
                        or isinstance(value, str)
                        and not value.strip()
                        or value == {}
                        or value == []
                        or isinstance(value, list)
                        and all(not str(item).strip() for item in value)
                    )
                    if secret and blank and existing:
                        continue
                    if (
                        isinstance(value, dict)
                        and isinstance(existing, dict)
                        and not secret
                    ):
                        result[key] = merge(existing, value)
                    else:
                        result[key] = deepcopy(value)
                return result

            merged = merge(old, config)
            next_id = str(merged.get("id") or item_id or "").strip()
            if not next_id or len(next_id) > 200:
                raise ApiError("A provider ID of 1–200 characters is required")
            merged["id"] = next_id
            if kind == "source" and not item_id:
                if any(
                    item.get("id") == next_id
                    for item in self.providers.list_provider_sources()[
                        "provider_sources"
                    ]
                ):
                    raise ApiError("Provider source ID already exists", status_code=409)
            if source_id:
                self.get_raw("source", source_id)
            try:
                if kind == "source":
                    await self.providers.upsert_provider_source(
                        item_id or next_id, merged
                    )
                elif item_id:
                    await self.providers.update_provider(item_id, merged)
                else:
                    await self.providers.create_provider(merged, source_id=source_id)
            except Exception as exc:
                raise ApiError(self.safe_error(exc)) from exc
            return {"id": next_id}

    def safe_error(self, error):
        """Return actionable error categories without arbitrary SDK request or key text."""
        text = str(error).lower()
        if "401" in text or "unauthorized" in text or "authentication" in text:
            return "Provider rejected authentication (401); check the configured credential"
        if "403" in text or "forbidden" in text:
            return "Provider denied access (403); check model permissions"
        if "429" in text or "rate limit" in text:
            return "Provider rate limit or quota reached (429)"
        if "timeout" in text or "timed out" in text:
            return "Provider connection timed out"
        if "connect" in text or "dns" in text or "resolve" in text:
            return "Could not connect to the provider endpoint"
        if "ssl" in text or "certificate" in text:
            return "Provider TLS certificate validation failed"
        if "already exists" in text or "exists already" in text:
            return "Provider ID already exists"
        if "not found" in text or "404" in text:
            return "Provider or model was not found"
        return "Provider operation failed; verify the protocol, endpoint and model configuration"

    async def operation(self, kind, action, item_id, enabled=None):
        """Delegate explicit model-list/test/mutation actions without leaking errors."""
        self.get_raw(kind, item_id)
        try:
            if action == "models":
                result = await self.providers.list_provider_source_models(item_id)
                return {
                    "provider_source_id": item_id,
                    "models": result.get("models", []),
                }
            if action == "test":
                result = await self.providers.test_provider(item_id)
                return {
                    "id": item_id,
                    "status": result["status"],
                    "error": self.safe_error(result["error"])
                    if result.get("error")
                    else None,
                }
            async with self.lock:
                if action == "enabled":
                    await self.providers.set_provider_enabled(item_id, enabled)
                elif kind == "source":
                    await self.providers.delete_provider_source(item_id)
                else:
                    await self.providers.delete_provider(item_id)
            return {"id": item_id}
        except Exception as exc:
            raise ApiError(self.safe_error(exc)) from exc
