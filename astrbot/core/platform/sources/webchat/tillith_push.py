"""Offline Tillith delivery. Device tokens stay outside chat, logs and exports."""

import asyncio
import json
import os
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

import aiohttp
import jwt

from astrbot import logger
from astrbot.core.utils.astrbot_path import get_astrbot_data_path


def device_path() -> Path:
    return Path(get_astrbot_data_path()) / "tillith-private" / "devices.sqlite"


def _open(path: Path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Create with restrictive mode before SQLite opens the file.
    os.close(os.open(path, os.O_RDWR | os.O_CREAT, 0o600))
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS devices (owner TEXT NOT NULL, device TEXT NOT NULL,"
        " token TEXT UNIQUE NOT NULL, PRIMARY KEY(owner, device))"
    )
    return conn


def register_device(path: Path, owner: str, device: str, token: str):
    with closing(_open(path)) as conn, conn:
        conn.execute("DELETE FROM devices WHERE token=?", (token,))
        conn.execute(
            "INSERT INTO devices(owner, device, token) VALUES (?, ?, ?) "
            "ON CONFLICT(owner,device) DO UPDATE SET token=excluded.token",
            (owner, device, token),
        )


def revoke_device(path: Path, owner: str, device: str, token: str | None = None):
    if path.is_file():
        with closing(_open(path)) as conn, conn:
            if token is None:
                conn.execute(
                    "DELETE FROM devices WHERE owner=? AND device=?", (owner, device)
                )
            else:
                conn.execute(
                    "DELETE FROM devices WHERE owner=? AND device=? AND token=?",
                    (owner, device, token),
                )


def _targets(path: Path, owner: str):
    if not path.is_file():
        return []
    with closing(_open(path)) as conn:
        return conn.execute(
            "SELECT device,token FROM devices WHERE owner=?", (owner,)
        ).fetchall()


def account_path() -> Path | None:
    value = os.getenv("TILLITH_FCM_SERVICE_ACCOUNT_FILE") or os.getenv(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    return Path(value) if value else None


async def send_fcm(targets, session_id: str):
    """Send data messages using a short-lived HTTP v1 service-account grant."""
    path = account_path()
    if not path:
        return []
    account = json.loads(await asyncio.to_thread(path.read_text, encoding="utf-8"))
    project = account["project_id"]
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project):
        raise ValueError("Invalid Firebase project configuration")
    oauth = "https://oauth2.googleapis.com/token"
    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": account["client_email"],
            "aud": oauth,
            "iat": now,
            "exp": now + 3600,
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
        },
        account["private_key"],
        algorithm="RS256",
    )
    invalid = []
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as client:
        async with client.post(
            oauth,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise RuntimeError("Firebase authorization failed")
            access = (await response.json())["access_token"]
        for device, token in targets:
            payload = {
                "message": {
                    "token": token,
                    "android": {"priority": "HIGH", "ttl": "86400s"},
                    "data": {
                        "kind": "tillith.chat",
                        "device": device,
                        "session": session_id,
                    },
                }
            }
            try:
                async with client.post(
                    f"https://fcm.googleapis.com/v1/projects/{project}/messages:send",
                    headers={"Authorization": f"Bearer {access}"},
                    json=payload,
                    allow_redirects=False,
                ) as response:
                    if response.status == 200:
                        continue
                    error = (await response.json()).get("error", {})
                    if any(
                        item.get("errorCode") == "UNREGISTERED"
                        for item in error.get("details", [])
                    ):
                        invalid.append((device, token))
                    else:
                        logger.warning("Tillith device notification was not accepted")
            except (aiohttp.ClientError, TimeoutError, ValueError):
                logger.warning("Tillith device notification delivery failed")
    return invalid


async def notify_offline(db, conversation_id: str, *, path=None, sender=send_fcm):
    registry = path or device_path()
    if not registry.is_file():
        return
    session = await db.get_platform_session_by_id(conversation_id)
    if not session or session.platform_id != "webchat" or not session.creator:
        return
    targets = await asyncio.to_thread(_targets, registry, session.creator)
    if targets:
        invalid = await sender(targets, conversation_id)
        for device, token in invalid:
            await asyncio.to_thread(
                revoke_device, registry, session.creator, device, token
            )
