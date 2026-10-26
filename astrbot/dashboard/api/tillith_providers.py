"""Provider-scoped management endpoints with write-only credentials."""

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_providers import TillithProviderService

from .auth import ScopeDependency

router = APIRouter(
    tags=["Tillith Providers"], dependencies=[Depends(ScopeDependency("provider"))]
)


class ProviderWrite(BaseModel):
    """Explicit provider fields; blank credentials preserve server-side values."""

    model_config = ConfigDict(extra="forbid")
    config: dict[str, Any]
    source_id: str | None = Field(default=None, max_length=200)


class ProviderEnabled(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


def get_service(request: Request):
    """Reuse the core provider manager and its existing persistence implementation."""
    state = request.app.state
    if not hasattr(state, "tillith_providers"):
        state.tillith_providers = TillithProviderService(state.services.providers)
    return state.tillith_providers


@router.get("/tillith/providers/schema")
async def provider_schema(service=Depends(get_service)):
    return ok(service.schema())


@router.get("/tillith/provider-sources")
async def provider_sources(service=Depends(get_service)):
    return ok(service.listing("source"))


@router.get("/tillith/providers")
async def providers(service=Depends(get_service)):
    return ok(service.listing("provider"))


@router.post("/tillith/provider-sources")
async def create_source(payload: ProviderWrite, service=Depends(get_service)):
    return ok(await service.save("source", payload.config))


@router.put("/tillith/provider-sources/by-id")
async def update_source(
    payload: ProviderWrite,
    source_id: str = Query(min_length=1, max_length=200),
    service=Depends(get_service),
):
    return ok(await service.save("source", payload.config, source_id))


@router.delete("/tillith/provider-sources/by-id")
async def delete_source(
    source_id: str = Query(min_length=1, max_length=200), service=Depends(get_service)
):
    return ok(await service.operation("source", "delete", source_id))


@router.get("/tillith/provider-sources/models")
async def source_models(
    source_id: str = Query(min_length=1, max_length=200), service=Depends(get_service)
):
    return ok(await service.operation("source", "models", source_id))


@router.post("/tillith/providers")
async def create_provider(payload: ProviderWrite, service=Depends(get_service)):
    return ok(
        await service.save("provider", payload.config, source_id=payload.source_id)
    )


@router.put("/tillith/providers/by-id")
async def update_provider(
    payload: ProviderWrite,
    provider_id: str = Query(min_length=1, max_length=200),
    service=Depends(get_service),
):
    return ok(await service.save("provider", payload.config, provider_id))


@router.delete("/tillith/providers/by-id")
async def delete_provider(
    provider_id: str = Query(min_length=1, max_length=200), service=Depends(get_service)
):
    return ok(await service.operation("provider", "delete", provider_id))


@router.patch("/tillith/providers/enabled")
async def enable_provider(
    payload: ProviderEnabled,
    provider_id: str = Query(min_length=1, max_length=200),
    service=Depends(get_service),
):
    return ok(
        await service.operation("provider", "enabled", provider_id, payload.enabled)
    )


@router.post("/tillith/providers/test")
async def test_provider(
    provider_id: str = Query(min_length=1, max_length=200), service=Depends(get_service)
):
    return ok(await service.operation("provider", "test", provider_id))
