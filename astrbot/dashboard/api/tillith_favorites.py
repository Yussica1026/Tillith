"""Owner-scoped REST endpoints for Tillith message favorites."""

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_favorites import get_favorite_service

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith"])


class FavoriteCreate(BaseModel):
    """Persisted message selected by the authenticated chat user."""

    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1, max_length=100)
    message_id: int = Field(gt=0)


@router.post("/tillith/favorites")
async def create_favorite(
    payload: FavoriteCreate,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    service = get_favorite_service(request.app.state.db)
    return ok(
        await service.create(auth.username, payload.session_id, payload.message_id)
    )


@router.get("/tillith/favorites")
async def list_favorites(
    request: Request,
    q: str = Query(default="", max_length=500),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    service = get_favorite_service(request.app.state.db)
    return ok(await service.list(auth.username, q, page, page_size))


@router.delete("/tillith/favorites/{favorite_id}")
async def delete_favorite(
    favorite_id: str,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    service = get_favorite_service(request.app.state.db)
    return ok(await service.delete(auth.username, favorite_id))
