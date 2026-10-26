"""Run the real Tillith/AstrBot core inside a Chaquopy worker thread.

Java calls run(filesDir + "/tillith") once on a dedicated thread, polls
status(), and retrieves connection() only after state becomes "ready".
stop() is safe from another thread. Restart the Android core process after
shutdown: AstrBot owns process-global configuration and plugin registries.

Gradle must package this module, runtime_bootstrap.py, and the astrbot package,
and extractPackages("astrbot") so plugin scanning and template paths work.
No desktop data directory, credentials, or diaries belong in APK assets.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import threading
from pathlib import Path

_lock = threading.Lock()
_state = "stopped"
_error = ""
_port = 0
_api_key = ""
_management_key = ""
_used = False
_stop_requested = threading.Event()
_loop: asyncio.AbstractEventLoop | None = None
_main_task: asyncio.Task | None = None


def status() -> str:
    """Return credential-free lifecycle state as JSON for the Java bridge."""
    with _lock:
        return json.dumps({"state": _state, "port": _port, "error": _error})


def connection() -> str:
    """Return the private API connection only after authenticated readiness.

    Returns:
        JSON containing baseUrl, apiKey and managementKey. Never log this result
        or persist it in WebView localStorage; keys live in App-private storage.

    Raises:
        RuntimeError: The core has not completed its readiness probe.
    """
    with _lock:
        if _state != "ready":
            raise RuntimeError("Tillith core is not ready")
        return json.dumps(
            {
                "baseUrl": f"http://127.0.0.1:{_port}",
                "apiKey": _api_key,
                "managementKey": _management_key,
            }
        )


def stop() -> None:
    """Request cancellation and cleanup without blocking the Java UI thread."""
    global _state
    with _lock:
        if _state not in {"starting", "ready"}:
            return
        _state = "stopping"
        _stop_requested.set()
        loop, task = _loop, _main_task
    if loop is not None and task is not None:
        try:
            loop.call_soon_threadsafe(task.cancel)
        except RuntimeError:
            pass  # The worker may already have closed its event loop.


async def _upgrade_management_identity(db, record):
    """Grant MCP once to an unchanged legacy identity, without reviving removals.

    Args:
        db: Existing core database.
        record: Active management identity loaded by its private key hash.

    Returns:
        The identity after a conditional atomic scope/name migration.

    Raises:
        RuntimeError: The identity was revoked during migration.
    """
    if (
        record.name != "Tillith on-device management"
        or record.created_by != "tillith-native"
        or set(record.scopes or []) != {"provider", "persona", "data"}
    ):
        return record
    from datetime import datetime, timezone

    from sqlalchemy import or_, update
    from sqlmodel import col

    from astrbot.core.db.po import ApiKey

    async with db.get_db() as session:
        async with session.begin():
            await session.execute(
                update(ApiKey)
                .where(
                    ApiKey.key_id == record.key_id,
                    ApiKey.key_hash == record.key_hash,
                    ApiKey.name == "Tillith on-device management",
                    ApiKey.created_by == "tillith-native",
                    ApiKey.scopes == record.scopes,
                    col(ApiKey.revoked_at).is_(None),
                    or_(
                        col(ApiKey.expires_at).is_(None),
                        col(ApiKey.expires_at) > datetime.now(timezone.utc),
                    ),
                )
                .values(
                    name="Tillith on-device management (MCP v1)",
                    scopes=["provider", "persona", "data", "mcp"],
                )
            )
    migrated = await db.get_active_api_key_by_hash(record.key_hash)
    if migrated is None:
        raise RuntimeError("Native API identity is no longer active")
    return migrated


async def _serve(root: Path, webui_dir: str) -> None:
    """Initialize the original lifecycle and serve its authenticated API.

    Args:
        root: App-private writable runtime root, configured before imports.
        webui_dir: Optional extracted dashboard directory; never downloaded.
    """
    global _state, _port, _api_key, _management_key

    # These imports must remain inside the configured worker entry point.
    from runtime_bootstrap import initialize_runtime_bootstrap

    initialize_runtime_bootstrap()
    import aiohttp
    from hypercorn.asyncio import serve
    from hypercorn.config import Config

    from astrbot.core import (
        LogBroker,
        LogManager,
        astrbot_config,
        db_helper,
        logger,
    )
    from astrbot.core.core_lifecycle import AstrBotCoreLifecycle
    from astrbot.dashboard.server import AstrBotDashboard
    from astrbot.dashboard.services.api_key_service import ApiKeyService

    # The native bridge uses API keys. Suppress generated dashboard password
    # display and use Hypercorn directly instead of the CLI's banner/startup.
    object.__setattr__(astrbot_config, "_generated_dashboard_password", None)
    astrbot_config["disable_metrics"] = True
    astrbot_config["dashboard"].update(
        {"enable": True, "host": "127.0.0.1", "disable_access_log": True}
    )
    astrbot_config.save_config()
    broker = LogBroker()
    LogManager.set_queue_handler(logger, broker)
    core = AstrBotCoreLifecycle(broker, db_helper)
    initialized = False
    tasks: list[asyncio.Task] = []
    shutdown = asyncio.Event()
    try:
        await core.initialize()
        initialized = True
        if _stop_requested.is_set():
            raise asyncio.CancelledError

        # Keep the same raw key and database key_id across process restarts;
        # OpenAPI chat ownership is tied to that key_id, not to created_by.
        keys = {}
        for filename, name, scopes in (
            ("native-api-key", "Tillith on-device owner", ["chat", "file"]),
            (
                "native-management-api-key",
                "Tillith on-device management (MCP v1)",
                ["provider", "persona", "data", "mcp"],
            ),
        ):
            key_path = root / filename
            if not key_path.exists():
                descriptor = os.open(
                    key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
                )
                with os.fdopen(descriptor, "w", encoding="ascii") as key_file:
                    key_file.write("abk_" + secrets.token_urlsafe(32))
                    key_file.flush()
                    os.fsync(key_file.fileno())
            key = key_path.read_text(encoding="ascii")
            if (
                not key.startswith("abk_")
                or len(key) != 47
                or not all(
                    char.isascii() and (char.isalnum() or char in "_-") for char in key
                )
            ):
                raise ValueError("Invalid native API identity file")
            key_hash = ApiKeyService.hash_key(key)
            record = await db_helper.get_active_api_key_by_hash(key_hash)
            if record is None:
                # Revoked or expired identities are never silently replaced.
                if any(
                    item.key_hash == key_hash
                    for item in await db_helper.list_api_keys()
                ):
                    raise RuntimeError("Native API identity is no longer active")
                record = await db_helper.create_api_key(
                    name=name,
                    key_hash=key_hash,
                    key_prefix=key[:12],
                    scopes=scopes,
                    created_by="tillith-native",
                )
            elif filename == "native-management-api-key":
                record = await _upgrade_management_identity(db_helper, record)
            # Do not promote an existing chat identity to management or silently
            # restore scopes which the owner deliberately removed.
            if set(record.scopes or []) != set(scopes):
                raise RuntimeError("Native API identity scopes do not match")
            keys[filename] = key
        key = keys["native-api-key"]
        management_key = keys["native-management-api-key"]

        dashboard = AstrBotDashboard(
            core, db_helper, core.dashboard_shutdown_event, webui_dir or None
        )
        # Reserve a candidate ephemeral port. A bind race fails the server task
        # and is surfaced as startup failure, never as a false ready state.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe_socket:
            probe_socket.bind(("127.0.0.1", 0))
            port = probe_socket.getsockname()[1]
        config = Config()
        config.bind = [f"127.0.0.1:{port}"]
        config.accesslog = None
        config.errorlog = None
        config.graceful_timeout = 5
        core_task = asyncio.create_task(core.start(), name="tillith-core")
        server_task = asyncio.create_task(
            serve(dashboard.asgi_app, config, shutdown_trigger=shutdown.wait),
            name="tillith-api",
        )
        tasks.extend((core_task, server_task))
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=2), trust_env=False
        ) as client:
            deadline = asyncio.get_running_loop().time() + 30
            while True:
                for task in tasks:
                    if task.done():
                        await task
                        raise RuntimeError("Core exited before readiness")
                try:
                    async with client.get(
                        f"http://127.0.0.1:{port}/api/v1/tillith/profile",
                        headers={"Authorization": f"Bearer {key}"},
                    ) as response:
                        body = await response.json()
                        identity = body.get("data", {})
                        if (
                            response.status == 200
                            and body.get("status") == "ok"
                            and identity.get("app") == "Tillith"
                            and isinstance(identity.get("username"), str)
                            and identity["username"]
                        ):
                            async with client.get(
                                f"http://127.0.0.1:{port}/api/v1/tillith/providers",
                                headers={"Authorization": f"Bearer {management_key}"},
                            ) as management_response:
                                management_body = await management_response.json()
                                if (
                                    management_response.status == 200
                                    and management_body.get("status") == "ok"
                                ):
                                    break
                except (aiohttp.ClientError, TimeoutError, ValueError):
                    pass
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError("Authenticated API readiness timed out")
                await asyncio.sleep(0.1)
        with _lock:
            if _stop_requested.is_set():
                raise asyncio.CancelledError
            _port, _api_key, _state = port, key, "ready"
            _management_key = management_key
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            if task.done():
                await task
        raise RuntimeError("Core stopped unexpectedly")
    finally:
        shutdown.set()
        try:
            if initialized:
                await asyncio.wait_for(core.stop(), timeout=20)
            else:
                await db_helper.engine.dispose()
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)


def run(root_path: str, webui_dir: str = "") -> None:
    """Block a Java worker thread until the embedded core stops or fails.

    Args:
        root_path: Absolute App-private directory supplied by Android filesDir.
        webui_dir: Optional absolute directory of extracted dashboard assets.

    Raises:
        RuntimeError: This interpreter already ran a core or has imported it.
        ValueError: The runtime path is not absolute.
    """
    global _used, _state, _error, _loop, _main_task, _port, _api_key, _management_key
    root = Path(root_path)
    if not root.is_absolute():
        raise ValueError("App-private runtime path must be absolute")
    with _lock:
        if _used or "astrbot.core" in sys.modules:
            raise RuntimeError("Restart the Android core process before starting again")
        _used = True
        _state, _error = "starting", ""
        _stop_requested.clear()
    try:
        root.mkdir(parents=True, exist_ok=True)
        # Set these before ANY astrbot import: its module initialization creates
        # configuration, paths, preferences, and database globals immediately.
        os.environ["ASTRBOT_ROOT"] = str(root.resolve())
        os.environ["ASTRBOT_DISABLE_METRICS"] = "1"
        os.environ["ASTRBOT_RELOAD"] = "0"
        for name in ("config", "plugins", "temp", "knowledge_base", "site-packages"):
            (root / "data" / name).mkdir(parents=True, exist_ok=True)
        sys.path.insert(0, str(root))
        sys.path.append(str(root / "data" / "site-packages"))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with _lock:
            _loop = loop
            _main_task = loop.create_task(_serve(root, webui_dir))
            if _stop_requested.is_set():
                _main_task.cancel()
        try:
            loop.run_until_complete(_main_task)
        finally:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.run_until_complete(loop.shutdown_default_executor())
            loop.close()
            asyncio.set_event_loop(None)
    except asyncio.CancelledError:
        if not _stop_requested.is_set():
            with _lock:
                _state, _error = "failed", "Core cancelled unexpectedly"
    except Exception as exc:
        # Exception messages may contain provider URLs or credentials. Expose
        # only the class and a missing-module name, never arbitrary exception text.
        detail = type(exc).__name__
        if isinstance(exc, ModuleNotFoundError) and exc.name:
            detail += ": missing module " + exc.name
        with _lock:
            _state, _error = "failed", detail
    finally:
        with _lock:
            if _state != "failed":
                _state = "stopped"
            _port, _api_key = 0, ""
            _management_key = ""
            _loop, _main_task = None, None
