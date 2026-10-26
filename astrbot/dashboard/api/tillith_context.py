"""Owned personal context APIs; persona administration stays on upstream endpoints."""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from astrbot.dashboard.responses import ApiError, ok
from astrbot.dashboard.services.tillith_context import (
    get_context_service,
    validate_keyword_pattern,
)

from .auth import AuthContext, ScopeDependency
from .tillith_messages import get_message_service

router = APIRouter(tags=["Tillith"])
require_chat = ScopeDependency("chat")


class ContextPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    persona_id: str | None = Field(default=None, max_length=200)
    worldbook_ids: list[str] | None = Field(default=None, max_length=30)
    memory_enabled: StrictBool | None = None
    memory_tools_enabled: StrictBool | None = None

    @model_validator(mode="after")
    def validate_patch(self):
        if not self.model_fields_set:
            raise ValueError("Provide a context field to change")
        for name in self.model_fields_set - {"persona_id"}:
            if getattr(self, name) is None:
                raise ValueError("Only persona_id accepts null")
        if self.worldbook_ids is not None and len(set(self.worldbook_ids)) != len(
            self.worldbook_ids
        ):
            raise ValueError("Worldbook IDs must be unique")
        return self


class PersonaSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = Field(default=None, max_length=200)
    default_config_id: str | None = Field(default=None, max_length=200)
    default_provider_id: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_patch(self):
        if not self.model_fields_set or (
            "display_name" in self.model_fields_set and self.display_name is None
        ):
            raise ValueError("Provide a preference; display_name cannot be null")
        if self.display_name is not None:
            self.display_name = self.display_name.strip()
        self.default_config_id = self.default_config_id or None
        self.default_provider_id = self.default_provider_id or None
        return self


class WorldbookEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, max_length=100)
    title: str = Field(default="", max_length=200)
    text: str = Field(min_length=1, max_length=8000)
    enabled: StrictBool = True
    always_active: StrictBool = False
    keywords: list[str] = Field(default_factory=list, max_length=20)
    regex: StrictBool = False
    case_sensitive: StrictBool = False
    scan_depth: int = Field(default=5, ge=0, le=20)
    position: Literal[
        "before_system", "after_system", "before_history", "after_history"
    ] = "after_system"
    role: Literal["system", "user", "assistant"] = "system"
    priority: int = Field(default=0, ge=-1000, le=1000)

    @model_validator(mode="after")
    def validate_matching(self):
        if self.position.endswith("system") and self.role != "system":
            raise ValueError("System positions require the system role")
        for keyword in self.keywords:
            if not keyword.strip() or len(keyword) > 200:
                raise ValueError("Keywords must contain 1–200 nonblank characters")
            if self.regex:
                validate_keyword_pattern(keyword)
        return self


class WorldbookWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    enabled: StrictBool = True
    entries: list[WorldbookEntry] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_entries(self):
        ids = [item.id for item in self.entries if item.id]
        if len(ids) != len(set(ids)):
            raise ValueError("Entry IDs must be unique")
        return self


class WorldbookImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    worldbooks: list[WorldbookWrite] = Field(min_length=1, max_length=30)


class MemoryWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    persona_id: str = Field(min_length=1, max_length=200)
    type: str = Field(default="note", min_length=1, max_length=50)
    text: str = Field(min_length=1, max_length=8000)
    starred: StrictBool = False
    source_message_id: int | None = Field(default=None, ge=1)


class MemoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str | None = Field(default=None, min_length=1, max_length=50)
    text: str | None = Field(default=None, min_length=1, max_length=8000)
    starred: StrictBool | None = None
    trashed: StrictBool | None = None

    @model_validator(mode="after")
    def reject_empty(self):
        if not self.model_fields_set or any(
            getattr(self, name) is None for name in self.model_fields_set
        ):
            raise ValueError("Provide at least one non-null memory field")
        return self


@router.get("/tillith/persona-options")
async def persona_options(request: Request, _auth: AuthContext = Depends(require_chat)):
    personas = await request.app.state.db.get_personas()
    service = get_context_service(request.app.state.db)
    preferences = {
        item.persona_id: await service.persona_preferences(
            _auth.username, item.persona_id
        )
        for item in personas
    }
    return ok(
        {
            "personas": [
                {
                    "id": item.persona_id,
                    "name": preferences[item.persona_id]["display_name"]
                    or item.persona_id,
                    "default_config_id": preferences[item.persona_id][
                        "default_config_id"
                    ],
                    "default_provider_id": preferences[item.persona_id][
                        "default_provider_id"
                    ],
                    "folder_id": item.folder_id,
                    "sort_order": item.sort_order,
                }
                for item in personas
            ]
        }
    )


@router.get("/tillith/persona-settings/{persona_id}")
async def get_persona_settings(
    persona_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        await get_context_service(request.app.state.db).persona_preferences(
            auth.username, persona_id
        )
    )


@router.get("/tillith/personas/{persona_id}/sessions")
async def persona_sessions(
    persona_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        {
            "session_ids": await get_context_service(
                request.app.state.db
            ).persona_sessions(auth.username, persona_id)
        }
    )


@router.patch("/tillith/persona-settings/{persona_id}")
async def patch_persona_settings(
    persona_id: str,
    payload: PersonaSettingsPatch,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    from .tillith import get_tillith_chat_options

    service = get_context_service(request.app.state.db)
    patch = payload.model_dump(exclude_unset=True)
    value = {**await service.persona_preferences(auth.username, persona_id), **patch}
    if {"default_config_id", "default_provider_id"} & payload.model_fields_set:
        options = (
            await get_tillith_chat_options(
                request, value["default_config_id"] or "default", auth
            )
        )["data"]
        if value["default_provider_id"] and value["default_provider_id"] not in {
            p["id"] for p in options["providers"]
        }:
            raise ApiError(
                "Chat provider not available in this configuration", status_code=400
            )
    return ok(await service.persona_preferences(auth.username, persona_id, patch))


@router.get("/tillith/sessions/{session_id}/context")
async def get_session_context(
    session_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        await get_context_service(request.app.state.db).context(
            auth.username, session_id
        )
    )


@router.patch("/tillith/sessions/{session_id}/context")
async def patch_session_context(
    session_id: str,
    payload: ContextPatch,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    messages = get_message_service(request)
    async with messages.locks[session_id]:
        if messages.chat.chat_runs_by_session.get(session_id):
            raise ApiError("Wait for the active response", status_code=409)
        return ok(
            await get_context_service(request.app.state.db).set_context(
                auth.username, session_id, payload.model_dump(exclude_unset=True)
            )
        )


@router.get("/tillith/worldbooks")
async def list_worldbooks(request: Request, auth: AuthContext = Depends(require_chat)):
    return ok(
        {
            "worldbooks": await get_context_service(request.app.state.db).list_books(
                auth.username
            )
        }
    )


@router.post("/tillith/worldbooks")
async def create_worldbook(
    payload: WorldbookWrite, request: Request, auth: AuthContext = Depends(require_chat)
):
    value = payload.model_dump()
    for entry in value["entries"]:
        entry.pop("id", None)
    return ok(
        await get_context_service(request.app.state.db).save_book(auth.username, value)
    )


@router.post("/tillith/worldbooks/import")
async def import_worldbooks(
    payload: WorldbookImport,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    service = get_context_service(request.app.state.db)
    result = []
    for book in payload.worldbooks:
        value = book.model_dump()
        for entry in value["entries"]:
            entry.pop("id", None)
        result.append(await service.save_book(auth.username, value))
    return ok({"worldbooks": result})


@router.get("/tillith/worldbooks/{book_id}/export")
async def export_worldbook(
    book_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    book = next(
        (
            item
            for item in await get_context_service(request.app.state.db).list_books(
                auth.username
            )
            if item["id"] == book_id
        ),
        None,
    )
    if not book:
        raise ApiError("Worldbook not found", status_code=404)
    book.pop("id")
    return ok({"version": 1, "worldbooks": [book]})


@router.put("/tillith/worldbooks/{book_id}")
async def update_worldbook(
    book_id: str,
    payload: WorldbookWrite,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        await get_context_service(request.app.state.db).save_book(
            auth.username, payload.model_dump(), book_id
        )
    )


@router.delete("/tillith/worldbooks/{book_id}")
async def delete_worldbook(
    book_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        await get_context_service(request.app.state.db).delete_book(
            auth.username, book_id
        )
    )


@router.get("/tillith/memories")
async def list_memories(
    request: Request,
    persona_id: str | None = Query(default=None, max_length=200),
    q: str = Query(default="", max_length=200),
    trashed: bool = False,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        {
            "memories": await get_context_service(request.app.state.db).list_memories(
                auth.username, persona_id, q, trashed
            )
        }
    )


@router.post("/tillith/memories")
async def create_memory(
    payload: MemoryWrite, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        await get_context_service(request.app.state.db).save_memory(
            auth.username, payload.model_dump()
        )
    )


@router.patch("/tillith/memories/{memory_id}")
async def update_memory(
    memory_id: str,
    payload: MemoryPatch,
    request: Request,
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        await get_context_service(request.app.state.db).save_memory(
            auth.username, payload.model_dump(exclude_unset=True), memory_id
        )
    )


@router.delete("/tillith/memories/{memory_id}")
async def trash_memory(
    memory_id: str, request: Request, auth: AuthContext = Depends(require_chat)
):
    return ok(
        await get_context_service(request.app.state.db).save_memory(
            auth.username, {"trashed": True}, memory_id
        )
    )


@router.get("/tillith/sessions/{session_id}/context-sources")
async def context_sources(
    session_id: str,
    request: Request,
    checkpoint_id: str | None = Query(default=None, max_length=100),
    run_id: str | None = Query(default=None, max_length=100),
    auth: AuthContext = Depends(require_chat),
):
    return ok(
        {
            "sources": await get_context_service(request.app.state.db).get_sources(
                auth.username, session_id, checkpoint_id, run_id
            )
        }
    )
