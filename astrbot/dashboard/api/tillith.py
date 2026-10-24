"""Tillith client identity derived from the existing authentication boundary."""

from fastapi import APIRouter, Depends

from astrbot import __version__
from astrbot.dashboard.responses import ok

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
