"""Personal reminders for existing Tillith webchat sessions."""

from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from astrbot.dashboard.responses import ApiError, ok
from astrbot.dashboard.services.chat_service import build_webchat_unified_msg_origin
from astrbot.dashboard.services.tillith_context import get_context_service

from .auth import AuthContext, ScopeDependency

router = APIRouter(tags=["Tillith"])


class ScheduleInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    session_id: str = Field(min_length=1, max_length=100)
    kind: Literal["message", "wake"]
    note: str = Field(min_length=1, max_length=2000)
    at: AwareDatetime | None = None
    daily: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    timezone: str = Field(default="UTC", min_length=1, max_length=96)

    @model_validator(mode="after")
    def validate_time(self):
        if bool(self.at) == bool(self.daily):
            raise ValueError("Choose a single date or a daily time")
        if self.at and self.at <= datetime.now(timezone.utc):
            raise ValueError("Choose a future date")
        try:
            ZoneInfo(self.timezone)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("Unknown timezone") from exc
        return self


def manager(request):
    scheduler = request.app.state.services.cron.core_lifecycle.cron_manager
    if scheduler is None:
        raise ApiError("Scheduler unavailable", status_code=503)
    return scheduler


def owned(job, username):
    return bool(
        job
        and job.payload
        and job.payload.get("origin") == "tillith"
        and job.payload.get("owner") == username
    )


def view(job):
    p = job.payload
    return {
        "id": job.job_id,
        "session_id": p["session_id"],
        "note": p["note"],
        "kind": p["kind"],
        "at": p.get("run_at"),
        "daily": p.get("daily"),
        "timezone": job.timezone,
        "enabled": job.enabled,
    }


@router.get("/tillith/schedules")
async def list_schedules(
    request: Request, auth: AuthContext = Depends(ScopeDependency("chat"))
):
    jobs = await manager(request).list_jobs("active_agent")
    return ok({"items": [view(job) for job in jobs if owned(job, auth.username)]})


@router.post("/tillith/schedules")
async def add_schedule(
    payload: ScheduleInput,
    request: Request,
    auth: AuthContext = Depends(ScopeDependency("chat")),
):
    db = request.app.state.db
    binding = await get_context_service(db).context(auth.username, payload.session_id)
    session = await db.get_platform_session_by_id(payload.session_id)
    if (
        not session
        or session.creator != auth.username
        or session.platform_id != "webchat"
    ):
        raise ApiError("Session not found", status_code=404)
    expression = None
    if payload.daily:
        hour, minute = payload.daily.split(":")
        expression = f"{minute} {hour} * * *"
    job = await manager(request).add_active_job(
        name="Tillith reminder",
        cron_expression=expression,
        timezone=payload.timezone,
        payload={
            "origin": "tillith",
            "owner": auth.username,
            "session_id": payload.session_id,
            "session": build_webchat_unified_msg_origin(session),
            "note": payload.note,
            "kind": payload.kind,
            "daily": payload.daily,
            "persona_id": binding["persona_id"],
        },
        run_once=payload.at is not None,
        run_at=payload.at,
    )
    return ok(view(job))


@router.delete("/tillith/schedules/{job_id}")
async def delete_schedule(
    job_id: str, request: Request, auth: AuthContext = Depends(ScopeDependency("chat"))
):
    scheduler = manager(request)
    if not owned(await scheduler.db.get_cron_job(job_id), auth.username):
        raise ApiError("Schedule not found", status_code=404)
    await scheduler.delete_job(job_id)
    return ok()
