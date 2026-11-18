"""Explicitly authorized tools for shared persona records in owned WebChat sessions."""

import json
from typing import get_args

from pydantic import ValidationError

from astrbot.api import star
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.core.agent.tool import FunctionTool
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tillith_life import (
    Category,
    EntryWrite,
    get_life_service,
)

READ = "tillith_life_read"
WRITE = "tillith_life_write"


class LifeTool(FunctionTool):
    async def call(self, context, **kwargs):
        agent = context.context
        event = agent.event
        persona_id = agent.extra.get("tool_persona_id")
        owner = event.get_sender_id()
        prefix = f"webchat!{owner}!"
        if (
            not persona_id
            or event.get_platform_name() != "webchat"
            or not event.session_id.startswith(prefix)
            or event.get_extra("_tool_persona_id") != persona_id
        ):
            return "This tool requires the current persona's owned WebChat session."
        session_id = event.session_id[len(prefix) :]
        service = get_life_service(agent.context.get_db())
        try:
            if self.name == READ:
                category = kwargs.get("category")
                if kwargs.keys() - {"category"} or (
                    category is not None and category not in get_args(Category)
                ):
                    return "Invalid life entry category or fields."
                rows = await service.list_entries(
                    owner, persona_id, session_id=session_id, category=category
                )
                return json.dumps(rows, ensure_ascii=False)
            if kwargs.keys() - {"category", "text", "day", "parent_id"}:
                return "Invalid life entry fields."
            value = EntryWrite.model_validate({**kwargs, "ai_visible": True})
            created = await service.create(
                owner, persona_id, value, session_id=session_id
            )
            return json.dumps({"id": created["id"], "category": created["category"]})
        except ApiError as exc:
            return exc.message
        except ValidationError:
            return "Invalid life entry fields."


class Main(star.Star):
    def __init__(self, context: star.Context):
        super().__init__(context)
        category = {"type": "string", "enum": list(get_args(Category))}
        context.add_llm_tools(
            LifeTool(
                name=READ,
                description="Read up to 20 recent entries explicitly shared with this persona. Optionally filter by category.",
                parameters={
                    "type": "object",
                    "properties": {"category": category},
                    "additionalProperties": False,
                },
            ),
            LifeTool(
                name=WRITE,
                description="Save a shared AI-authored entry for the current persona, or reply to a visible root board post.",
                parameters={
                    "type": "object",
                    "properties": {
                        "category": category,
                        "text": {"type": "string", "maxLength": 8000},
                        "day": {
                            "type": "string",
                            "description": "Date in YYYY-MM-DD form",
                        },
                        "parent_id": {
                            "type": "string",
                            "description": "Root board post ID for a reply",
                        },
                    },
                    "required": ["category", "text", "day"],
                    "additionalProperties": False,
                },
            ),
        )

    @filter.on_llm_request()
    async def filter_life_tools(self, event: AstrMessageEvent, req: ProviderRequest):
        if not req.func_tool:
            return
        persona = self.context.persona_manager.get_persona_v3_by_id(
            event.get_extra("_tool_persona_id")
        )
        selected = (
            persona.get("tools")
            if persona and event.get_platform_name() == "webchat"
            else None
        )
        for name in (READ, WRITE):
            if name not in (selected or []):
                req.func_tool.remove_tool(name)
