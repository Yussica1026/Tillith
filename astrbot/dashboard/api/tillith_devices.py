"""Chat-scoped Android notification enrollment."""

import asyncio
import json
import re
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from astrbot.core.platform.sources.webchat import tillith_push
from astrbot.dashboard.responses import ApiError, ok

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith"])


@router.post("/tillith/devices")
async def register(
    request: Request, auth: AuthContext = Depends(ScopeDependency("chat"))
):
    # Never echo submitted input via framework request-validation details.
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 8192:
            raise ApiError("Invalid device registration", 400)
        raw.extend(chunk)
    try:
        body = json.loads(raw)
        if (
            set(body) != {"device_id", "token", "owner"}
            or body["owner"] != auth.username
        ):
            raise ValueError
        device = str(UUID(body["device_id"]))
        token = body["token"]
        if not isinstance(token, str) or not re.fullmatch(r"[!-~]{16,4096}", token):
            raise ValueError
    except (TypeError, AttributeError, ValueError):
        raise ApiError("Invalid device registration", 400) from None
    config = tillith_push.account_path()
    if not config or not config.is_file():
        raise ApiError("Firebase delivery is not configured on this server", 503)
    await asyncio.to_thread(
        tillith_push.register_device,
        tillith_push.device_path(),
        auth.username,
        device,
        token,
    )
    return ok({"registered": True})


@router.delete("/tillith/devices/{device_id}")
async def revoke(device_id: UUID, auth: AuthContext = Depends(ScopeDependency("chat"))):
    await asyncio.to_thread(
        tillith_push.revoke_device,
        tillith_push.device_path(),
        auth.username,
        str(device_id),
    )
    return ok()
