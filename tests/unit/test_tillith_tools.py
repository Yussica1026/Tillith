"""Exercise the mobile MCP contract against the existing service and persistence."""

import importlib.util
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import update

from astrbot.core.db.po import ApiKey
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.dashboard.api.tillith_tools import router
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.api_key_service import ApiKeyService
from astrbot.dashboard.services.tools_service import ToolsService


class ToolManager:
    def __init__(self):
        self.config = {
            "mcpServers": {
                "team/remote": {
                    "url": "https://example.invalid/mcp?token=fixture-query-secret",
                    "headers": {"Authorization": "Bearer fixture-header-secret"},
                    "transport": "streamable_http",
                    "active": True,
                },
                "local": {"command": "python", "args": ["server.py"], "active": True},
            }
        }
        self.mcp_server_runtime_view = {}
        self.tested = []
        self.enabled = []
        self.disabled = []
        self.fail_test = False
        self.fail_enable = False
        self.func_list = [
            SimpleNamespace(
                name="plugin_tool",
                description="A plugin tool",
                parameters={},
                active=True,
                handler_module_path=None,
            )
        ]

    def load_mcp_config(self):
        return deepcopy(self.config)

    def save_mcp_config(self, config):
        self.config = deepcopy(config)
        return True

    def iter_builtin_tools(self):
        return [
            SimpleNamespace(
                name="builtin_clock", description=None, parameters={}, active=True
            )
        ]

    def is_builtin_tool(self, name):
        return name == "builtin_clock"

    async def activate_llm_tool_async(self, name, **kwargs):
        self.func_list[0].active = True
        return name == "plugin_tool"

    async def deactivate_llm_tool_async(self, name):
        self.func_list[0].active = False
        return name == "plugin_tool"

    async def test_mcp_server_connection(self, config):
        self.tested.append(deepcopy(config))
        if self.fail_test:
            raise RuntimeError("fixture-header-secret fixture-query-secret")
        return ["lookup_weather", "lookup_time"]

    async def enable_mcp_server(self, name, config, **kwargs):
        self.enabled.append(name)
        if self.fail_enable:
            raise RuntimeError("fixture-header-secret")
        self.mcp_server_runtime_view[name] = SimpleNamespace(
            client=SimpleNamespace(
                tools=[SimpleNamespace(name="lookup_weather")],
                server_errlogs=["fixture-log-secret"],
            )
        )

    async def disable_mcp_server(self, name, **kwargs):
        self.disabled.append(name)
        self.mcp_server_runtime_view.pop(name, None)


@pytest_asyncio.fixture
async def client(monkeypatch):
    monkeypatch.setattr(
        "astrbot.dashboard.services.tools_service.sp.global_get",
        AsyncMock(return_value={}),
    )
    manager = ToolManager()
    core = SimpleNamespace(
        provider_manager=SimpleNamespace(llm_tools=manager),
        astrbot_config_mgr=SimpleNamespace(get_conf_list=lambda: [], confs={}),
    )
    app = FastAPI()
    app.include_router(router)
    app.state.services = SimpleNamespace(tools=ToolsService(core))
    app.state.jwt_secret = "fixture-tillith-tools-secret-32-bytes"
    keys = {
        ApiKeyService.hash_key("management"): SimpleNamespace(
            key_id="manager", scopes=["mcp"]
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
        transport=httpx.ASGITransport(app=app),
        base_url="http://fixture",
        headers={"X-API-Key": "management"},
    ) as browser:
        yield browser, manager


def draft(**updates):
    return {
        "name": "new/server",
        "url": "https://example.invalid/mcp",
        "transport": "streamable_http",
        "headers": {},
        "active": True,
        **updates,
    }


@pytest.mark.asyncio
async def test_mcp_scope_and_listing_never_expose_credentials(client):
    browser, manager = client
    await manager.enable_mcp_server("team/remote", {})
    assert (
        await browser.get("/tillith/tools", headers={"X-API-Key": "invalid"})
    ).status_code == 401
    assert (
        await browser.get("/tillith/mcp/servers", headers={"X-API-Key": "chat-only"})
    ).status_code == 403
    response = await browser.get("/tillith/mcp/servers")
    assert response.status_code == 200
    assert "fixture-" not in response.text
    remote, local = response.json()["data"]["servers"]
    assert remote["url"] == "" and remote["url_secret"] and remote["headers_present"]
    assert remote["connected"] and remote["tools"] == ["lookup_weather"]
    assert local["readonly"] and local["transport"] == "stdio"
    assert "command" not in local and "args" not in local
    tools = (await browser.get("/tillith/tools")).json()["data"]["tools"]
    assert tools[1]["readonly"] and tools[1]["description"] == ""


@pytest.mark.asyncio
async def test_remote_crud_discovery_and_tool_switch_use_existing_service(client):
    browser, manager = client
    response = await browser.post("/tillith/mcp/servers", json=draft())
    assert response.status_code == 200 and response.json()["data"]["connected"]
    response = await browser.post(
        "/tillith/mcp/servers/test",
        params={"server_name": "new/server"},
        json=draft(url=""),
    )
    assert response.json()["data"] == {"tools": ["lookup_weather", "lookup_time"]}
    response = await browser.put(
        "/tillith/mcp/servers/by-name",
        params={"server_name": "new/server"},
        json=draft(name="renamed/server", active=False),
    )
    assert response.status_code == 200
    assert response.json()["data"]["name"] == "renamed/server"
    assert (
        not response.json()["data"]["active"]
        and not response.json()["data"]["connected"]
    )
    assert "new/server" not in manager.config["mcpServers"]
    response = await browser.patch(
        "/tillith/tools/enabled?tool_name=plugin_tool", json={"enabled": False}
    )
    assert response.status_code == 200 and response.json()["data"] == {}
    assert not manager.func_list[0].active
    assert (
        await browser.patch(
            "/tillith/tools/enabled?tool_name=builtin_clock", json={"enabled": False}
        )
    ).status_code == 400
    response = await browser.delete(
        "/tillith/mcp/servers/by-name", params={"server_name": "renamed/server"}
    )
    assert response.status_code == 200 and response.json()["data"] == {}
    assert "renamed/server" not in manager.config["mcpServers"]


@pytest.mark.asyncio
async def test_blank_edit_preserves_secrets_and_disabled_create_never_connects(client):
    browser, manager = client
    response = await browser.put(
        "/tillith/mcp/servers/by-name",
        params={"server_name": "team/remote"},
        json=draft(name="team/remote", url="", active=False),
    )
    assert response.status_code == 200
    saved = manager.config["mcpServers"]["team/remote"]
    assert saved["url"].endswith("fixture-query-secret")
    assert saved["headers"] == {"Authorization": "Bearer fixture-header-secret"}
    response = await browser.post("/tillith/mcp/servers", json=draft(active=False))
    assert response.status_code == 200
    assert manager.tested == [] and manager.enabled == []
    assert not response.json()["data"]["active"]
    response = await browser.patch(
        "/tillith/mcp/servers/enabled",
        params={"server_name": "new/server"},
        json={"enabled": True},
    )
    assert response.status_code == 200 and response.json()["data"]["connected"]


@pytest.mark.asyncio
async def test_stdio_cannot_be_created_edited_tested_or_enabled_but_can_be_stopped(
    client,
):
    browser, manager = client
    assert (
        await browser.post(
            "/tillith/mcp/servers", json={**draft(), "command": "python"}
        )
    ).status_code == 422
    assert (
        await browser.post("/tillith/mcp/servers", json=draft(transport="stdio"))
    ).status_code == 422
    for path, method in (("by-name", "PUT"), ("test", "POST")):
        assert (
            await browser.request(
                method,
                "/tillith/mcp/servers/" + path,
                params={"server_name": "local"},
                json=draft(),
            )
        ).status_code == 400
    assert (
        await browser.patch(
            "/tillith/mcp/servers/enabled?server_name=local", json={"enabled": True}
        )
    ).status_code == 400
    response = await browser.patch(
        "/tillith/mcp/servers/enabled?server_name=local", json={"enabled": False}
    )
    assert (
        response.status_code == 200
        and not manager.config["mcpServers"]["local"]["active"]
    )
    assert manager.enabled == [] and manager.tested == []
    assert (
        await browser.delete("/tillith/mcp/servers/by-name?server_name=local")
    ).status_code == 200


@pytest.mark.asyncio
async def test_failed_connection_is_private_and_saved_changes_are_reported_honestly(
    client,
):
    browser, manager = client
    manager.fail_test = True
    response = await browser.post("/tillith/mcp/servers/test", json=draft())
    assert response.status_code == 502 and "fixture-" not in response.text
    response = await browser.post("/tillith/mcp/servers", json=draft())
    assert (
        response.status_code == 502 and "new/server" not in manager.config["mcpServers"]
    )
    manager.fail_test = False
    manager.fail_enable = True
    response = await browser.put(
        "/tillith/mcp/servers/by-name?server_name=team%2Fremote",
        json=draft(name="team/remote", url=""),
    )
    assert response.status_code == 200
    result = response.json()["data"]
    assert result["active"] and not result["connected"] and result["warning"]
    assert "fixture-" not in response.text
    response = await browser.post(
        "/tillith/mcp/servers", json=draft(name="team/remote")
    )
    assert response.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid",
    [
        {"url": "file:///etc/passwd"},
        {"url": "https://user:pass@example.invalid/mcp"},
        {"headers": {"Authorization": "Bearer synthetic\r\nInjected: yes"}},
    ],
)
async def test_invalid_remote_config_rejected_before_connecting(client, invalid):
    browser, manager = client
    assert (
        await browser.post("/tillith/mcp/servers", json=draft(**invalid))
    ).status_code == 400
    assert manager.enabled == [] and manager.tested == []


@pytest_asyncio.fixture
async def identities(tmp_path):
    path = Path(__file__).resolve().parents[2] / "mobile/native-python/bootstrap.py"
    spec = importlib.util.spec_from_file_location("tillith_native_tools_fixture", path)
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    db = SQLiteDatabase(str(tmp_path / "identities.db"))
    await db.initialize()
    db.inited = True
    try:
        yield db, bootstrap
    finally:
        await db.engine.dispose()


@pytest.mark.asyncio
async def test_native_scope_upgrade_is_atomic_and_never_restores_removed_mcp(
    identities,
):
    db, bootstrap = identities
    record = await db.create_api_key(
        name="Tillith on-device management",
        key_hash="fixture-native",
        key_prefix="fixture",
        scopes=["provider", "persona", "data"],
        created_by="tillith-native",
    )
    migrated = await bootstrap._upgrade_management_identity(db, record)
    assert migrated.key_id == record.key_id and migrated.key_hash == record.key_hash
    assert migrated.name == "Tillith on-device management (MCP v1)"
    assert set(migrated.scopes) == {"provider", "persona", "data", "mcp"}
    async with db.get_db() as session:
        async with session.begin():
            await session.execute(
                update(ApiKey)
                .where(ApiKey.key_id == record.key_id)
                .values(scopes=["provider", "persona", "data"])
            )
    removed = await db.get_active_api_key_by_hash(record.key_hash)
    unchanged = await bootstrap._upgrade_management_identity(db, removed)
    assert "mcp" not in unchanged.scopes


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["owner", "name", "scopes", "revoked", "expired"])
async def test_native_scope_upgrade_does_not_promote_modified_or_inactive_keys(
    identities, change
):
    db, bootstrap = identities
    record = await db.create_api_key(
        name="custom" if change == "name" else "Tillith on-device management",
        key_hash="fixture-native",
        key_prefix="fixture",
        scopes=["provider"] if change == "scopes" else ["provider", "persona", "data"],
        created_by="user" if change == "owner" else "tillith-native",
        expires_at=datetime.now(timezone.utc) - timedelta(days=1)
        if change == "expired"
        else None,
    )
    if change == "revoked":
        await db.revoke_api_key(record.key_id)
    if change in {"revoked", "expired"}:
        with pytest.raises(RuntimeError, match="no longer active"):
            await bootstrap._upgrade_management_identity(db, record)
    else:
        await bootstrap._upgrade_management_identity(db, record)
    stored = await db.get_api_key_by_id(record.key_id)
    assert "mcp" not in stored.scopes
