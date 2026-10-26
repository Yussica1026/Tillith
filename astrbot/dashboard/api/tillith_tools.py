"""MCP-scoped mobile tools and remote server management."""

from typing import Any, Generic, Literal, TypeVar

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_tools import TillithToolsService

from .auth import ScopeDependency

router = APIRouter(
    tags=["Tillith Tools"], dependencies=[Depends(ScopeDependency("mcp"))]
)


class TillithMcpWrite(BaseModel):
    """Only remote transports and explicit editable fields are accepted."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    url: str = Field(default="", max_length=8192)
    transport: Literal["streamable_http", "sse"] = "streamable_http"
    headers: dict[str, str] = Field(default_factory=dict)
    active: StrictBool = True


class TillithToolEnabled(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


class TillithToolView(BaseModel):
    name: str
    description: str
    active: bool
    readonly: bool
    origin: Literal["builtin", "mcp", "plugin", "unknown"]
    origin_name: str
    origin_display_name: str
    parameters: dict[str, Any]
    permission: str | None = None


class TillithToolList(BaseModel):
    tools: list[TillithToolView]


class TillithMcpServerView(BaseModel):
    name: str
    active: bool
    connected: bool
    transport: Literal["streamable_http", "sse", "stdio", "unsupported"]
    url: str
    url_secret: bool
    headers_present: bool
    tools: list[str]
    readonly: bool
    warning: str | None = None


class TillithMcpServerList(BaseModel):
    servers: list[TillithMcpServerView]


class TillithMcpTestResult(BaseModel):
    tools: list[str]


ResponseData = TypeVar("ResponseData")


class TillithToolsResponse(BaseModel, Generic[ResponseData]):
    status: Literal["ok"]
    message: str | None = None
    data: ResponseData


def get_service(request: Request) -> TillithToolsService:
    return TillithToolsService(request.app.state.services.tools)


@router.get("/tillith/tools", response_model=TillithToolsResponse[TillithToolList])
async def list_tools(service: TillithToolsService = Depends(get_service)):
    return ok({"tools": await service.list_tools()})


@router.patch("/tillith/tools/enabled", response_model=TillithToolsResponse[dict])
async def set_tool_enabled(
    payload: TillithToolEnabled,
    tool_name: str = Query(min_length=1, max_length=200),
    service: TillithToolsService = Depends(get_service),
):
    await service.set_tool_enabled(tool_name, payload.enabled)
    return ok()


@router.get(
    "/tillith/mcp/servers", response_model=TillithToolsResponse[TillithMcpServerList]
)
async def list_servers(service: TillithToolsService = Depends(get_service)):
    return ok({"servers": service.servers()})


@router.post(
    "/tillith/mcp/servers", response_model=TillithToolsResponse[TillithMcpServerView]
)
async def create_server(
    payload: TillithMcpWrite,
    service: TillithToolsService = Depends(get_service),
):
    return ok(await service.save(payload.model_dump()))


@router.put(
    "/tillith/mcp/servers/by-name",
    response_model=TillithToolsResponse[TillithMcpServerView],
)
async def update_server(
    payload: TillithMcpWrite,
    server_name: str = Query(min_length=1, max_length=200),
    service: TillithToolsService = Depends(get_service),
):
    return ok(await service.save(payload.model_dump(), server_name))


@router.delete(
    "/tillith/mcp/servers/by-name", response_model=TillithToolsResponse[dict]
)
async def delete_server(
    server_name: str = Query(min_length=1, max_length=200),
    service: TillithToolsService = Depends(get_service),
):
    await service.delete(server_name)
    return ok()


@router.patch(
    "/tillith/mcp/servers/enabled",
    response_model=TillithToolsResponse[TillithMcpServerView],
)
async def set_server_enabled(
    payload: TillithToolEnabled,
    server_name: str = Query(min_length=1, max_length=200),
    service: TillithToolsService = Depends(get_service),
):
    return ok(await service.set_enabled(server_name, payload.enabled))


@router.post(
    "/tillith/mcp/servers/test",
    response_model=TillithToolsResponse[TillithMcpTestResult],
)
async def test_server(
    payload: TillithMcpWrite,
    server_name: str | None = Query(default=None, min_length=1, max_length=200),
    service: TillithToolsService = Depends(get_service),
):
    return ok(await service.test(payload.model_dump(), server_name))
