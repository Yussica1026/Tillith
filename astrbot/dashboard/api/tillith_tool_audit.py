"""Read-only, chat-scoped access to Tillith tool invocation audit records."""

from fastapi import APIRouter, Depends, Query, Request

from astrbot.dashboard.responses import ok
from astrbot.dashboard.services.tillith_tool_audit import get_tool_audit_service

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith"])


@router.get("/tillith/tool-audit")
async def list_tool_audit(
    request: Request,
    session_id: str | None = Query(default=None, min_length=1, max_length=100),
    q: str = Query(default="", max_length=500),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_tool_audit_service(request.app.state.db).list(
            auth.username,
            session_id=session_id,
            query=q,
            page=page,
            page_size=page_size,
        )
    )
