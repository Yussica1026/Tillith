"""Credential-safe web search settings for Tillith clients."""

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, StrictBool

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_web_search import TillithWebSearchService

from .auth import ScopeDependency

router = APIRouter(
    tags=["Tillith Web Search"],
    dependencies=[Depends(ScopeDependency("config"))],
)

SearchProvider = Literal[
    "serpapi",
    "deepseek",
    "tavily",
    "baidu_ai_search",
    "bocha",
    "brave",
    "firecrawl",
    "exa",
    "anysearch",
]


class SearchProfileWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    provider: SearchProvider
    show_sources: StrictBool
    api_key: str | list[str] | None = None
    clear_key: StrictBool = False


def get_service(request: Request) -> TillithWebSearchService:
    state = request.app.state
    if not hasattr(state, "tillith_web_search"):
        state.tillith_web_search = TillithWebSearchService(
            state.services.config_profiles
        )
    return state.tillith_web_search


@router.get("/tillith/web-search-profiles")
async def list_web_search_profiles(service=Depends(get_service)):
    return ok(service.listing())


@router.put("/tillith/web-search-profiles/{profile_id}")
async def update_web_search_profile(
    profile_id: str,
    payload: SearchProfileWrite,
    service=Depends(get_service),
):
    return ok(
        await service.save(
            profile_id,
            enabled=payload.enabled,
            provider=payload.provider,
            show_sources=payload.show_sources,
            api_key=payload.api_key,
            api_key_supplied="api_key" in payload.model_fields_set,
            clear_key=payload.clear_key,
        )
    )
