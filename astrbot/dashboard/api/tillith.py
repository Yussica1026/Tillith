"""Tillith APIs derived from the existing authentication boundary."""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from astrbot import __version__
from astrbot.core.provider.provider import Provider
from astrbot.dashboard.responses import ApiError, ok
from astrbot.dashboard.services.tillith_session_service import TillithSessionService

from .auth import AuthContext, ScopeDependency
from .tillith_context import router as context_router
from .tillith_messages import router as messages_router
from .tillith_providers import router as providers_router

router = APIRouter(tags=["Tillith"])
router.include_router(messages_router)
router.include_router(providers_router)
router.include_router(context_router)


class SessionMetaPatch(BaseModel):
    """Only editable flags are accepted; ownership is supplied by authentication."""

    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1, max_length=100)
    pinned: StrictBool | None = None
    starred: StrictBool | None = None
    archived: StrictBool | None = None

    @model_validator(mode="after")
    def validate_flags(self):
        """Reject empty updates and explicit null rather than silently resetting flags."""
        fields = self.model_fields_set - {"session_id"}
        if not fields or any(getattr(self, field) is None for field in fields):
            raise ValueError("Provide at least one boolean session flag")
        return self


def get_session_service(request: Request) -> TillithSessionService:
    """Reuse the core database and existing chat service for this application."""
    if not hasattr(request.app.state, "tillith_sessions"):
        request.app.state.tillith_sessions = TillithSessionService(
            request.app.state.db, request.app.state.services.chat
        )
    return request.app.state.tillith_sessions


@router.get("/tillith/session-meta")
async def get_session_meta(
    session_id: str | None = Query(default=None, min_length=1, max_length=100),
    page: int = Query(default=1, ge=1, le=10000),
    page_size: int = Query(default=100, ge=1, le=200),
    auth: AuthContext = Depends(ScopeDependency("chat")),
    service: TillithSessionService = Depends(get_session_service),
):
    """List live owned sessions with persisted flags or their false defaults."""
    return ok(await service.list_meta(auth.username, session_id, page, page_size))


@router.patch("/tillith/session-meta")
async def patch_session_meta(
    payload: SessionMetaPatch,
    auth: AuthContext = Depends(ScopeDependency("chat")),
    service: TillithSessionService = Depends(get_session_service),
):
    """Change only supplied flags for an existing owned session."""
    return ok(
        await service.patch_meta(
            auth.username,
            payload.session_id,
            payload.model_dump(exclude_unset=True, exclude={"session_id"}),
        )
    )


@router.get("/tillith/search")
async def search_messages(
    q: str = Query(min_length=1, max_length=200),
    role: Literal["user", "assistant"] | None = None,
    session_id: str | None = Query(default=None, min_length=1, max_length=100),
    page: int = Query(default=1, ge=1, le=10000),
    page_size: int = Query(default=20, ge=1, le=50),
    auth: AuthContext = Depends(ScopeDependency("chat")),
    service: TillithSessionService = Depends(get_session_service),
):
    """Find literal visible-text matches in the authenticated identity's sessions."""
    q = q.strip()
    if not q:
        raise ApiError("Search query must not be blank", status_code=400)
    return ok(await service.search(auth.username, q, role, session_id, page, page_size))


@router.get("/tillith/profile")
async def get_tillith_profile(
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    """Return the authenticated session owner without creating a conversation.

    Args:
        auth: Existing authenticated chat identity.

    Returns:
        Client identity and the bundled core version.
    """
    return ok(
        {"app": "Tillith", "username": auth.username, "core_version": __version__}
    )


@router.get("/tillith/chat-options")
async def get_tillith_chat_options(
    request: Request,
    config_id: str = Query(default="default"),
    _auth: AuthContext = Depends(ScopeDependency("chat")),
):
    """List local chat choices without exposing provider or persona secrets.

    Args:
        request: Request carrying the existing configuration and provider services.
        config_id: Configuration whose enabled chat provider pool is requested.
        _auth: Existing authenticated chat identity.

    Returns:
        Configuration labels, loaded chat model labels and the default config ID.

    Raises:
        ApiError: If the requested configuration does not exist.
    """
    profiles = request.app.state.services.config_profiles
    configs = [
        {"id": info["id"], "name": info.get("name") or info["id"]}
        for info in profiles.list_profiles()["info_list"]
    ]
    if config_id not in {item["id"] for item in configs}:
        raise ApiError("Configuration not found", status_code=404)
    config = profiles.get_profile(config_id)["config"]
    settings = config.get("provider_settings", {})
    pool = settings.get("provider_pool", ["*"])
    providers = []
    manager = request.app.state.core_lifecycle.provider_manager
    if settings.get("enable", True) and isinstance(pool, list):
        for provider in list(manager.provider_insts):
            if not isinstance(provider, Provider):
                continue
            provider_id = provider.provider_config.get("id")
            if not provider_id or ("*" not in pool and provider_id not in pool):
                continue
            provider_config = manager.get_provider_config_by_id(
                provider_id, merged=True
            )
            if not provider_config or not provider_config.get("enable", False):
                continue
            model = provider.get_model()
            if not isinstance(model, str) or not model:
                continue
            providers.append(
                {
                    "id": provider_id,
                    "name": provider_config.get("name") or provider_id,
                    "model": model,
                }
            )
    return ok(
        {"configs": configs, "providers": providers, "default_config_id": "default"}
    )
