"""Inject explicitly enabled personal context using the standard request hook."""

import json

from sqlalchemy import select

from astrbot.api import star
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.core.db.po import PlatformMessageHistory
from astrbot.core.platform.sources.webchat.webchat_queue_mgr import webchat_queue_mgr
from astrbot.dashboard.responses import ApiError
from astrbot.dashboard.services.tillith_context import get_context_service

TOOLS = ("tillith_memory_search", "tillith_memory_create", "tillith_memory_update")


class Main(star.Star):
    """Use authenticated webchat session ownership for every hook and tool call."""

    def __init__(self, context: star.Context):
        super().__init__(context)
        self.service = get_context_service(context.get_db())

    async def identity(self, event):
        """Resolve only a genuine owned webchat session, never model-provided identity."""
        if event.get_platform_name() != "webchat" or not event.session_id.startswith(
            "webchat!"
        ):
            raise ApiError(
                "Tillith context is only available in owned webchat sessions"
            )
        owner = event.get_sender_id()
        session_id = event.session_id.rsplit("!", 1)[-1]
        binding = await self.service.context(owner, session_id)
        return owner, session_id, binding

    @filter.on_llm_request()
    async def inject_context(self, event: AstrMessageEvent, req: ProviderRequest):
        """Decorate the actual request and publish the exact per-checkpoint sources."""
        session_id = None
        try:
            owner, session_id, binding = await self.identity(event)
        except ApiError:
            binding = {"memory_tools_enabled": False}
        if req.func_tool and not binding["memory_tools_enabled"]:
            for name in TOOLS:
                req.func_tool.remove_tool(name)
        checkpoint_id = event.get_extra("llm_checkpoint_id")
        if not checkpoint_id or session_id is None:
            return
        run_id = str(event.message_obj.message_id)
        evidence = await self.service.inject(
            owner, session_id, run_id, checkpoint_id, req
        )
        await webchat_queue_mgr.put_back_queue(
            run_id,
            {
                "type": "context_sources",
                "data": evidence,
                "message_id": run_id,
                "streaming": True,
            },
        )

    @filter.llm_tool(name="tillith_memory_search")
    async def memory_search(self, event: AstrMessageEvent, query: str):
        """Search enabled memories for this session's persona.

        Args:
            query(string): Text to find in this persona's memories.
        """
        owner, session_id, binding = await self.identity(event)
        if not binding["memory_tools_enabled"] or not binding["persona_id"]:
            return "Memory tools are not enabled for this persona session"
        rows = await self.service.list_memories(
            owner, binding["persona_id"], query[:200]
        )
        return json.dumps(
            [row for row in rows if not row["invalidated"]][:10], ensure_ascii=False
        )

    @filter.llm_tool(name="tillith_memory_create")
    async def memory_create(self, event: AstrMessageEvent, text: str):
        """Save a memory only when the user enabled memory tools for this persona.

        Args:
            text(string): The concise fact or preference to remember.
        """
        owner, session_id, binding = await self.identity(event)
        if not binding["memory_tools_enabled"] or not binding["persona_id"]:
            return "Memory tools are not enabled for this persona session"
        if not text.strip() or len(text) > 8000:
            return "Memory text must contain 1–8000 characters"
        async with self.service.db.engine.connect() as conn:
            source_id = (
                await conn.execute(
                    select(PlatformMessageHistory.id)
                    .where(
                        PlatformMessageHistory.platform_id == "webchat",
                        PlatformMessageHistory.user_id == session_id,
                        PlatformMessageHistory.llm_checkpoint_id
                        == event.get_extra("llm_checkpoint_id"),
                        PlatformMessageHistory.content["type"].as_string() == "user",
                    )
                    .order_by(PlatformMessageHistory.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        return json.dumps(
            await self.service.save_memory(
                owner,
                {
                    "persona_id": binding["persona_id"],
                    "text": text,
                    "source_message_id": source_id,
                },
            ),
            ensure_ascii=False,
        )

    @filter.llm_tool(name="tillith_memory_update")
    async def memory_update(self, event: AstrMessageEvent, memory_id: str, text: str):
        """Update an existing memory in this session's enabled persona scope.

        Args:
            memory_id(string): Identifier returned by memory search.
            text(string): Replacement memory text.
        """
        owner, _, binding = await self.identity(event)
        if not binding["memory_tools_enabled"] or not binding["persona_id"]:
            return "Memory tools are not enabled for this persona session"
        rows = await self.service.list_memories(owner, binding["persona_id"])
        if not any(row["id"] == memory_id for row in rows):
            return "Memory not found for this persona"
        if not text.strip() or len(text) > 8000:
            return "Memory text must contain 1–8000 characters"
        return json.dumps(
            await self.service.save_memory(owner, {"text": text}, memory_id),
            ensure_ascii=False,
        )
