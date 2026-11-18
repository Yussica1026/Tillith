"""Authenticated mobile life entries."""

from fastapi import APIRouter, Depends, Request

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_life import (
    EntryPatch,
    EntryWrite,
    get_life_service,
)

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith Life"])
require_chat = ScopeDependency("chat")


@router.get("/tillith/life/{persona_id:path}/entries")
async def list_entries(
    persona_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        {
            "items": await get_life_service(request.app.state.db).list_entries(
                auth.username, persona_id
            )
        }
    )


@router.post("/tillith/life/{persona_id:path}/entries")
async def create_entry(
    persona_id: str,
    payload: EntryWrite,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        await get_life_service(request.app.state.db).create(
            auth.username, persona_id, payload
        )
    )


@router.patch("/tillith/life/{persona_id:path}/entries/{entry_id}")
async def update_entry(
    persona_id: str,
    entry_id: str,
    payload: EntryPatch,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        await get_life_service(request.app.state.db).change(
            auth.username, persona_id, entry_id, payload
        )
    )


@router.delete("/tillith/life/{persona_id:path}/entries/{entry_id}")
async def delete_entry(
    persona_id: str,
    entry_id: str,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        await get_life_service(request.app.state.db).change(
            auth.username, persona_id, entry_id, None
        )
    )
