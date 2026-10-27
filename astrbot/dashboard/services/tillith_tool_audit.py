"""Owner-scoped audit records for completed WebChat tool calls."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Column,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    and_,
    func,
    or_,
    select,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from astrbot.core.db.po import PlatformMessageHistory, PlatformSession


tool_audit = Table(
    "tillith_tool_audit",
    MetaData(),
    Column("id", String, primary_key=True),
    Column("creator", String, nullable=False, index=True),
    Column("session_id", String, nullable=False, index=True),
    Column("message_id", Integer, nullable=False, index=True),
    Column("checkpoint_id", String, nullable=False),
    Column("run_id", String, nullable=False),
    Column("call_id", String, nullable=False),
    Column("tool", String, nullable=False),
    Column("args_redacted", JSON, nullable=False),
    Column("result_summary", Text, nullable=False),
    Column("status", String, nullable=False),
    Column("created_at", String, nullable=False),
    UniqueConstraint(
        "creator", "run_id", "call_id", name="uix_tillith_tool_audit_call"
    ),
)

_SENSITIVE_KEYS = {
    "accesstoken",
    "apikey",
    "authorization",
    "clientsecret",
    "cookie",
    "credential",
    "key",
    "password",
    "passwd",
    "privatekey",
    "proxyauthorization",
    "secret",
    "sessiontoken",
    "setcookie",
    "token",
}
_SENSITIVE_SUFFIXES = ("apikey", "password", "secret", "token", "credential")
_MAX_DEPTH = 8
_MAX_COLLECTION_ITEMS = 100
_MAX_ARG_STRING = 4096
_MAX_RESULT_SUMMARY = 2000


def _sensitive_key(value: object) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(value).casefold())
    return normalized in _SENSITIVE_KEYS or normalized.endswith(_SENSITIVE_SUFFIXES)


def _redact_url(match: re.Match[str]) -> str:
    raw = match.group(0)
    try:
        parsed = urlsplit(raw)
        if not parsed.query and parsed.username is None and parsed.password is None:
            return raw
        query = [
            (key, "[REDACTED]" if _sensitive_key(key) else value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        ]
        host = parsed.hostname or ""
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        return urlunsplit(
            (
                parsed.scheme,
                host,
                parsed.path,
                urlencode(query, safe="[]"),
                parsed.fragment,
            )
        )
    except (TypeError, ValueError):
        return raw


def redact_text(value: object) -> str:
    """Remove common credential shapes from an arbitrary result string."""
    text = str(value)
    text = re.sub(
        r"(?i)\b(bearer|basic)\s+[a-z0-9._~+/=-]+",
        r"\1 [REDACTED]",
        text,
    )
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", text)
    text = re.sub(
        r'''(?i)((?<![a-z0-9_])["']?(?:[a-z0-9_-]*api[_-]?key|access[_-]?token|authorization|cookie|password|secret|token)["']?\s*[:=]\s*)["']?([^\s,;}&"'<>]+)''',
        r"\1[REDACTED]",
        text,
    )
    return re.sub(r"https?://[^\s\"'<>]+", _redact_url, text)


def redact_value(value, *, depth: int = 0):
    """Recursively redact and bound JSON-like tool arguments."""
    if depth >= _MAX_DEPTH:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        output = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_COLLECTION_ITEMS:
                output["[TRUNCATED]"] = True
                break
            output[str(key)] = (
                "[REDACTED]"
                if _sensitive_key(key)
                else redact_value(item, depth=depth + 1)
            )
        return output
    if isinstance(value, (list, tuple)):
        output = [
            redact_value(item, depth=depth + 1)
            for item in value[:_MAX_COLLECTION_ITEMS]
        ]
        if len(value) > _MAX_COLLECTION_ITEMS:
            output.append("[TRUNCATED]")
        return output
    if isinstance(value, str):
        redacted = redact_text(value)
        return (
            redacted
            if len(redacted) <= _MAX_ARG_STRING
            else redacted[:_MAX_ARG_STRING] + "…"
        )
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(value)[:_MAX_ARG_STRING]


def summarize_result(value: object) -> str:
    """Produce a bounded, redacted summary without retaining raw tool output."""
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            parsed = None
    if parsed is not None and not isinstance(parsed, str):
        summary = json.dumps(
            redact_value(parsed), ensure_ascii=False, separators=(",", ":")
        )
    else:
        summary = redact_text(value)
    return summary[:_MAX_RESULT_SUMMARY] + (
        "…" if len(summary) > _MAX_RESULT_SUMMARY else ""
    )


class TillithToolAuditService:
    """Persist completed tool calls and expose only their authenticated owner."""

    def __init__(self, db):
        self.db = db
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()

    async def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        async with self._schema_lock:
            if not self._schema_ready:
                async with self.db.engine.begin() as connection:
                    await connection.run_sync(
                        lambda sync: tool_audit.create(sync, checkfirst=True)
                    )
                self._schema_ready = True

    async def record_completed(
        self,
        *,
        creator: str,
        session_id: str,
        platform_id: str,
        checkpoint_id: str,
        run_id: str,
        call_id: str,
        tool: str,
        args,
        result,
        created_at: float | None = None,
    ) -> dict | None:
        """Record one paired tool result; untraceable/non-WebChat calls are ignored."""
        if platform_id != "webchat" or not all(
            isinstance(value, str) and value
            for value in (creator, session_id, checkpoint_id, run_id, call_id, tool)
        ):
            return None
        session = await self.db.get_platform_session_by_id(session_id)
        if (
            not session
            or session.creator != creator
            or session.platform_id != "webchat"
        ):
            return None
        history = PlatformMessageHistory.__table__
        async with self.db.engine.connect() as connection:
            message_id = (
                await connection.execute(
                    select(history.c.id)
                    .where(
                        history.c.platform_id == platform_id,
                        history.c.user_id == session_id,
                        history.c.llm_checkpoint_id == checkpoint_id,
                        history.c.content["type"].as_string() == "user",
                    )
                    .order_by(history.c.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        if message_id is None:
            return None
        try:
            timestamp = (
                datetime.fromtimestamp(created_at, timezone.utc)
                if isinstance(created_at, (int, float))
                else datetime.now(timezone.utc)
            )
        except (OverflowError, OSError, ValueError):
            timestamp = datetime.now(timezone.utc)
        summary = summarize_result(result)
        status = (
            "error" if summary.casefold().lstrip().startswith("error:") else "completed"
        )
        await self.ensure_schema()
        values = {
            "id": str(uuid4()),
            "creator": creator,
            "session_id": session_id,
            "message_id": message_id,
            "checkpoint_id": checkpoint_id,
            "run_id": run_id,
            "call_id": call_id,
            "tool": tool[:200],
            "args_redacted": redact_value(args if isinstance(args, dict) else {}),
            "result_summary": summary,
            "status": status,
            "created_at": timestamp.isoformat(),
        }
        async with self.db.engine.begin() as connection:
            statement = sqlite_insert(tool_audit).values(**values)
            await connection.execute(
                statement.on_conflict_do_nothing(
                    index_elements=[
                        tool_audit.c.creator,
                        tool_audit.c.run_id,
                        tool_audit.c.call_id,
                    ]
                )
            )
            row = (
                (
                    await connection.execute(
                        select(tool_audit).where(
                            tool_audit.c.creator == creator,
                            tool_audit.c.run_id == run_id,
                            tool_audit.c.call_id == call_id,
                        )
                    )
                )
                .mappings()
                .one()
            )
        return self._item(row, session.display_name)

    async def list(
        self,
        creator: str,
        *,
        session_id: str | None = None,
        query: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        await self.ensure_schema()
        audit = tool_audit.c
        sessions = PlatformSession.__table__.c
        statement = (
            select(tool_audit, sessions.display_name.label("session_title"))
            .select_from(
                tool_audit.outerjoin(
                    PlatformSession.__table__,
                    and_(
                        audit.session_id == sessions.session_id,
                        audit.creator == sessions.creator,
                    ),
                )
            )
            .where(audit.creator == creator)
        )
        if session_id:
            statement = statement.where(audit.session_id == session_id)
        query = query.strip()
        if query:
            needle = query.casefold()
            statement = statement.where(
                or_(
                    func.instr(func.lower(audit.tool), needle) > 0,
                    func.instr(func.lower(audit.result_summary), needle) > 0,
                )
            )
        statement = (
            statement.order_by(audit.created_at.desc(), audit.id)
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
        async with self.db.engine.connect() as connection:
            rows = (await connection.execute(statement)).mappings().all()
        return {
            "items": [
                self._item(row, row["session_title"]) for row in rows[:page_size]
            ],
            "page": page,
            "page_size": page_size,
            "has_more": len(rows) > page_size,
        }

    @staticmethod
    def _item(row, session_title=None) -> dict:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "session_title": session_title or "新的对话",
            "message_id": str(row["message_id"]),
            "tool": row["tool"],
            "args_redacted": row["args_redacted"],
            "result_summary": row["result_summary"],
            "status": row["status"],
            "created_at": row["created_at"],
        }


def get_tool_audit_service(db) -> TillithToolAuditService:
    if not hasattr(db, "_tillith_tool_audit_service"):
        db._tillith_tool_audit_service = TillithToolAuditService(db)
    return db._tillith_tool_audit_service
