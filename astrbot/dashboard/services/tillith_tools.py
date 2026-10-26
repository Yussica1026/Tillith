"""Mobile tool management with remote-only MCP configuration and private secrets."""

from copy import deepcopy
from urllib.parse import urlsplit

from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tools_service import ToolsService, ToolsServiceError


class TillithToolsService:
    def __init__(self, tools: ToolsService) -> None:
        self.tools = tools

    @staticmethod
    def public_server(server: dict) -> dict:
        """Return editable metadata without credentials or raw connection logs.

        Args:
            server: Existing configuration combined with current runtime status.

        Returns:
            The mobile MCP server representation.
        """
        url = server.get("url", "")
        transport = server.get("transport", server.get("type", "sse"))
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
        except ValueError:
            parsed = None
        remote = (
            bool(parsed and parsed.scheme in {"http", "https"} and parsed.hostname)
            and transport in {"streamable_http", "sse"}
            and not any(key in server for key in ("command", "args", "env"))
        )
        private_url = bool(
            parsed and (parsed.query or parsed.username or parsed.password)
        )
        return {
            "name": server["name"],
            "active": bool(server.get("active", True)),
            "connected": bool(server.get("connected", False)),
            "transport": transport
            if remote
            else "stdio"
            if "command" in server
            else "unsupported",
            "url": url if remote and not private_url else "",
            "url_secret": private_url,
            "headers_present": bool(server.get("headers")),
            "tools": [
                name for name in server.get("tools", []) if isinstance(name, str)
            ],
            "readonly": not remote,
        }

    def servers(self) -> list[dict]:
        try:
            return [
                self.public_server(server) for server in self.tools.get_mcp_servers()
            ]
        except ToolsServiceError:
            raise ApiError("无法读取 MCP 服务，请检查核心状态。", 502) from None

    def server(self, name: str) -> dict:
        server = next(
            (server for server in self.servers() if server["name"] == name), None
        )
        if server is None:
            raise ApiError("MCP 服务不存在，请刷新列表。", 404)
        return server

    def stored(self, name: str) -> dict:
        try:
            config = self.tools.get_mcp_server_config(name)
        except ToolsServiceError:
            raise ApiError("无法读取 MCP 配置，请检查核心状态。", 502) from None
        if config is None:
            raise ApiError("MCP 服务不存在，请刷新列表。", 404)
        return config

    def config(self, draft: dict, old_name: str | None) -> dict:
        """Combine explicit remote fields with write-only existing credentials.

        Args:
            draft: Validated mobile form fields.
            old_name: Existing server name when editing or checking a saved server.

        Returns:
            A remote HTTP configuration suitable for the existing MCP service.

        Raises:
            ApiError: The URL, headers, or existing transport cannot be managed here.
        """
        old = deepcopy(self.stored(old_name)) if old_name is not None else {}
        if old and self.public_server({**old, "name": old_name})["readonly"]:
            raise ApiError("此服务使用本地进程或不支持的协议，只能停用或删除。")
        url = draft["url"].strip() or str(old.get("url", ""))
        try:
            parsed = urlsplit(url)
            valid = (
                parsed.scheme in {"http", "https"}
                and parsed.hostname
                and not parsed.username
                and not parsed.password
                and not parsed.fragment
                and not any(ord(char) < 32 for char in url)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ApiError("请填写 HTTP 或 HTTPS 地址；认证信息请放在请求头中。")
        headers = draft["headers"] or old.get("headers", {})
        for name, value in headers.items():
            if (
                not name
                or any(char in name for char in "\r\n:")
                or any(char in value for char in "\r\n")
            ):
                raise ApiError("请求头名称和值不能包含换行，名称不能包含冒号。")
        old.pop("type", None)
        return {
            **old,
            "url": url,
            "transport": draft["transport"],
            "headers": headers,
            "active": draft["active"],
        }

    async def list_tools(self) -> list[dict]:
        try:
            return [
                {
                    **tool,
                    "description": tool.get("description") or "",
                    "parameters": tool.get("parameters") or {},
                }
                for tool in await self.tools.get_tool_list()
            ]
        except ToolsServiceError:
            raise ApiError("无法读取工具列表，请检查核心状态。", 502) from None

    async def set_tool_enabled(self, name: str, enabled: bool) -> None:
        tool = next(
            (tool for tool in await self.list_tools() if tool["name"] == name), None
        )
        if tool is None:
            raise ApiError("工具不存在，请刷新列表。", 404)
        if tool.get("readonly"):
            raise ApiError("内置工具由核心配置控制，不能在此切换。")
        if (
            enabled
            and tool.get("origin") == "mcp"
            and self.server(tool["origin_name"])["readonly"]
        ):
            raise ApiError("不能从手机启用本地进程 MCP 的工具。")
        try:
            await self.tools.toggle_tool({"name": name, "activate": enabled})
        except ToolsServiceError:
            raise ApiError("工具状态未能修改，请刷新后重试。", 502) from None

    async def save(self, draft: dict, old_name: str | None = None) -> dict:
        config = self.config(draft, old_name)
        name = draft["name"].strip()
        if not name:
            raise ApiError("请填写服务名称。")
        if name != old_name and any(
            server["name"] == name for server in self.servers()
        ):
            raise ApiError("此服务名称已存在，请使用其他名称。", 409)
        try:
            if old_name is not None:
                await self.tools.update_mcp_server(
                    {**config, "name": name, "oldName": old_name}
                )
            elif config["active"]:
                await self.tools.add_mcp_server({**config, "name": name})
            else:
                # Upstream add always connects. An explicitly disabled new server
                # is saved without starting a connection or a local process.
                document = self.tools.tool_mgr.load_mcp_config()
                document.setdefault("mcpServers", {})[name] = config
                if not self.tools.tool_mgr.save_mcp_config(document):
                    raise ToolsServiceError("Configuration save failed")
        except ToolsServiceError:
            stored = self.tools.get_mcp_server_config(name)
            if stored == config:
                return {
                    **self.server(name),
                    "warning": "配置已保存，但连接状态同步失败；请检查后重试。",
                }
            raise ApiError(
                "MCP 配置未能保存，请检查服务地址和认证信息后重试。", 502
            ) from None
        result = self.server(name)
        if result["active"] and not result["connected"]:
            result["warning"] = "配置已保存，服务尚未连接；请检查连接后重试。"
        return result

    async def set_enabled(self, name: str, enabled: bool) -> dict:
        server = self.server(name)
        if enabled and server["readonly"]:
            raise ApiError("此服务使用本地进程或不支持的协议，只能停用或删除。")
        try:
            if server["readonly"]:
                await self.tools.tool_mgr.disable_mcp_server(name, timeout=10)
                document = self.tools.tool_mgr.load_mcp_config()
                document["mcpServers"][name]["active"] = False
                if not self.tools.tool_mgr.save_mcp_config(document):
                    raise ToolsServiceError("Configuration save failed")
            else:
                await self.tools.update_mcp_server({"name": name, "active": enabled})
        except (ToolsServiceError, TimeoutError):
            result = self.server(name)
            if result["active"] == enabled:
                return {
                    **result,
                    "warning": "启用设置已保存，但连接状态同步失败；请刷新后重试。",
                }
            raise ApiError("服务状态未能修改，请刷新后重试。", 502) from None
        result = self.server(name)
        if result["active"] and not result["connected"]:
            result["warning"] = "服务已设为启用，但尚未连接。"
        return result

    async def delete(self, name: str) -> None:
        self.stored(name)
        try:
            await self.tools.delete_mcp_server({"name": name})
        except ToolsServiceError:
            raise ApiError("删除未能完整完成，请刷新列表检查服务状态。", 502) from None

    async def test(self, draft: dict, old_name: str | None = None) -> dict:
        config = self.config(draft, old_name)
        try:
            tools = await self.tools.test_mcp_connection({"mcp_server_config": config})
        except ToolsServiceError:
            raise ApiError(
                "连接检查失败，请核对服务地址、协议和认证信息。", 502
            ) from None
        return {"tools": [name for name in tools if isinstance(name, str)]}
