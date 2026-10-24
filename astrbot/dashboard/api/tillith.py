"""Tillith client identity derived from the existing authentication boundary."""

from fastapi import APIRouter, Depends, Query, Request

from astrbot import __version__
from astrbot.core.provider.provider import Provider
from astrbot.dashboard.responses import ApiError, ok

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith"])


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
