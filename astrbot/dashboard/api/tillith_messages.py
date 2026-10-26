"""Tillith's WebSocket bridge to the canonical resumable chat service."""

import asyncio
import json
from contextlib import aclosing
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from astrbot.dashboard.responses import ApiError, ok
from astrbot.dashboard.services.chat_service import ChatServiceError
from astrbot.dashboard.services.tillith_messages import TillithMessageService

from .auth import AuthContext, ScopeDependency, _require_api_key_scope
from .open_api import _extract_ws_api_key

router = APIRouter(tags=["Tillith"])


class TillithChatCommand(BaseModel):
    """Public transport fields; internal checkpoint and identity overrides are forbidden."""

    model_config = ConfigDict(extra="forbid")
    t: Literal["send", "edit", "regenerate", "resume", "ping"] = "send"
    session_id: str | None = Field(default=None, max_length=100)
    username: str | None = None  # Accepted for old client compatibility; never trusted.
    message_id: int | str | None = None
    message: str | list[dict[str, Any]] | None = None
    content: dict[str, Any] | None = None
    run_id: str | None = Field(default=None, max_length=100)
    config_id: str | None = None
    selected_provider: str | None = None
    selected_model: str | None = None
    flags: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_operation(self):
        """Reject incomplete operations before any persistent mutation."""
        if self.t == "ping":
            return self
        if self.t == "resume":
            if not self.run_id:
                raise ValueError("run_id is required")
            return self
        if not self.session_id:
            raise ValueError("session_id is required")
        if self.t == "send" and not self.message:
            raise ValueError("message is required")
        if self.t in {"edit", "regenerate"}:
            if self.message_id is None or not str(self.message_id).isdigit():
                raise ValueError("message_id must be a persisted message ID")
            self.message_id = int(self.message_id)
        if self.t == "edit" and not self.content:
            raise ValueError("content is required")
        return self


def get_message_service(connection):
    """Reuse the shared service across HTTP and WebSocket requests."""
    state = connection.app.state
    if not hasattr(state, "tillith_messages"):
        state.tillith_messages = TillithMessageService(
            state.db, state.services.chat, state.services.open_api
        )
    return state.tillith_messages


class VersionSelection(BaseModel):
    """An existing immutable version to restore."""

    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=100)


@router.get("/tillith/sessions/{session_id}/messages/{message_id}/versions")
async def list_message_versions(
    session_id: str,
    message_id: int,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_message_service(request).list_versions(
            auth.username, session_id, message_id
        )
    )


@router.post("/tillith/sessions/{session_id}/messages/{message_id}/version")
async def select_message_version(
    session_id: str,
    message_id: int,
    payload: VersionSelection,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_message_service(request).select_version(
            auth.username, session_id, message_id, payload.version_id
        )
    )


@router.delete("/tillith/sessions/{session_id}/messages/{message_id}/turn")
async def delete_message_turn(
    session_id: str,
    message_id: int,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_message_service(request).delete_turn(
            auth.username, session_id, message_id
        )
    )


@router.post("/tillith/sessions/{session_id}/messages/{message_id}/branch")
async def branch_message(
    session_id: str,
    message_id: int,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_message_service(request).branch(auth.username, session_id, message_id)
    )


@router.delete(
    "/tillith/sessions/{session_id}/messages/{message_id}/versions/{version_id}"
)
async def delete_message_version(
    session_id: str,
    message_id: int,
    version_id: str,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    return ok(
        await get_message_service(request).delete_version(
            auth.username, session_id, message_id, version_id
        )
    )


@router.websocket("/tillith/chat/ws")
async def tillith_chat_ws(websocket: WebSocket):
    """Forward canonical run events while allowing the producer to outlive this socket."""
    await websocket.accept()
    try:
        raw_key = _extract_ws_api_key(websocket)
        if not raw_key:
            try:
                first_message = await asyncio.wait_for(
                    websocket.receive_json(), timeout=10
                )
            except WebSocketDisconnect:
                return
            except (asyncio.TimeoutError, ValueError, TypeError):
                first_message = None
            if (
                not isinstance(first_message, dict)
                or first_message.get("t") != "auth"
                or not isinstance(first_message.get("api_key"), str)
                or not first_message["api_key"]
            ):
                raise ApiError("Missing API key", status_code=401)
            raw_key = first_message["api_key"]
            authenticated_by_message = True
        else:
            authenticated_by_message = False
        auth = await _require_api_key_scope(websocket, raw_key, "chat")
    except ApiError:
        await websocket.send_json(
            {
                "type": "error",
                "code": "UNAUTHORIZED",
                "data": "Chat authentication required",
            }
        )
        await websocket.close(code=1008)
        return
    if authenticated_by_message:
        await websocket.send_json({"type": "auth_ok"})
    service = get_message_service(websocket)
    try:
        while True:
            try:
                command = TillithChatCommand.model_validate(
                    await websocket.receive_json()
                )
                if command.t == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if command.t == "resume":
                    stream = await service.resume(auth.username, command.run_id)
                else:
                    stream, run_id = await service.start(
                        auth.username, command.model_dump(exclude_none=True)
                    )
                    await websocket.send_json(
                        {
                            "type": "run_started",
                            "data": {"run_id": run_id},
                            "session_id": command.session_id,
                        }
                    )
                async with aclosing(stream):
                    async for frame in stream:
                        # The in-process source emits one complete SSE frame per yield.
                        if frame.startswith("data: "):
                            event = json.loads(frame[6:].strip())
                            if event.get("type") != "end":
                                await websocket.send_json(event)
                        else:
                            await websocket.send_json({"type": "keepalive"})
                # The producer flushes durable history after its end control frame.
                await websocket.send_json({"type": "end"})
            except ValidationError:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "INVALID_MESSAGE",
                        "data": "Invalid chat command",
                    }
                )
            except ApiError as exc:
                code = "RUN_UNAVAILABLE" if command.t == "resume" else "INVALID_MESSAGE"
                if exc.status_code == 409:
                    code = "SESSION_BUSY"
                await websocket.send_json(
                    {"type": "error", "code": code, "data": exc.message}
                )
            except ChatServiceError as exc:
                await websocket.send_json(
                    {"type": "error", "code": "INVALID_MESSAGE", "data": str(exc)}
                )
    except WebSocketDisconnect:
        return
