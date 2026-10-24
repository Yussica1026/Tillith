"""Run the local Tillith core with isolated data and loopback-only access."""

import argparse
import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def main() -> int:
    """Manage the isolated local development core.

    Returns:
        Zero when the requested operation completes, otherwise a nonzero status.
    """
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "status", "stop"))
    parser.add_argument("--port", type=int, default=6195)
    parser.add_argument("--webui-dir", type=Path, default=root / "mobile" / "dist")
    parser.add_argument("--wait", type=int, default=60)
    args = parser.parse_args()
    runtime = root / ".runtime"
    python = (
        runtime / "core" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    if not python.is_file():
        parser.error("Install the Python 3.12 core environment in .runtime/core first.")
    if Path(sys.executable).resolve() != python.resolve():
        return subprocess.call(
            [str(python), str(Path(__file__).resolve()), *sys.argv[1:]]
        )

    import psutil

    state_path = runtime / "core-process.json"
    state = (
        json.loads(state_path.read_text(encoding="utf-8"))
        if state_path.exists()
        else {}
    )
    process = None
    if state:
        try:
            candidate = psutil.Process(state["pid"])
            if (
                abs(candidate.create_time() - state["created_at"]) < 0.01
                and str(root / "main.py") in candidate.cmdline()
            ):
                process = candidate
        except (psutil.Error, KeyError, TypeError):
            pass

    if args.action == "stop":
        if process is not None:
            # Windows virtual environments may keep a launcher above the real core.
            children = process.children(recursive=True)
            for child in reversed(children):
                try:
                    child.terminate()
                except psutil.NoSuchProcess:
                    pass
            try:
                process.terminate()
            except psutil.NoSuchProcess:
                pass
            try:
                process.wait(timeout=10)
            except psutil.TimeoutExpired:
                try:
                    process.kill()
                    process.wait(timeout=5)
                except psutil.NoSuchProcess:
                    pass
            _, remaining = psutil.wait_procs(children, timeout=5)
            for child in remaining:
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
        state_path.unlink(missing_ok=True)
        print(json.dumps({"running": False, "action": "stop"}))
        return 0

    if args.action == "status" or process is not None:
        reachable = False
        if process is not None:
            try:
                with urlopen(state["url"], timeout=3) as response:
                    reachable = response.status == 200
            except (OSError, URLError):
                pass
        print(
            json.dumps(
                {"running": process is not None, "reachable": reachable, **state}
            )
        )
        return 0 if process is not None and reachable else 1

    if not 1024 <= args.port <= 65535 or not 1 <= args.wait <= 300:
        parser.error("Use a port from 1024 to 65535 and a wait from 1 to 300 seconds.")
    webui = args.webui_dir.resolve()
    if not (webui / "index.html").is_file():
        parser.error(
            "Build the local mobile frontend or pass --webui-dir to a local build."
        )
    # Fail before spawning if another local service owns the selected port.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", args.port))

    local = runtime / "local"
    data = local / "data"
    temporary = local / "temp"
    data.mkdir(parents=True, exist_ok=True)
    temporary.mkdir(parents=True, exist_ok=True)
    config_path = data / "cmd_config.json"
    credential_path = runtime / "local-admin.json"
    url = f"http://127.0.0.1:{args.port}"
    if not config_path.exists():
        # Load the existing standalone password utility without importing the core.
        spec = importlib.util.spec_from_file_location(
            "tillith_dev_password", root / "astrbot/core/utils/auth_password.py"
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("Password utility is unavailable")
        passwords = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(passwords)
        password = passwords.generate_dashboard_password()
        config = {
            "dashboard": {
                "enable": True,
                "username": "tillith",
                "password": passwords.hash_md5_dashboard_password(password),
                "pbkdf2_password": passwords.hash_dashboard_password(password),
                "password_storage_upgraded": True,
                "password_change_required": False,
                "host": "127.0.0.1",
                "port": args.port,
            },
            "disable_metrics": True,
            "trace_enable": False,
            "provider": [],
            "platform": [],
            "provider_settings": {"sandbox": {"cua_telemetry_enabled": False}},
        }
        credential_path.write_text(
            json.dumps({"username": "tillith", "password": password, "url": url}),
            encoding="utf-8",
        )
        credential_path.chmod(0o600)
    else:
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        config["dashboard"].update(enable=True, host="127.0.0.1", port=args.port)
        config.update(disable_metrics=True, trace_enable=False)
        config.setdefault("provider_settings", {}).setdefault("sandbox", {})[
            "cua_telemetry_enabled"
        ] = False
    config_path.write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    config_path.chmod(0o600)

    environment = os.environ.copy()
    environment.update(
        ASTRBOT_ROOT=str(local),
        ASTRBOT_DISABLE_METRICS="1",
        ASTRBOT_DESKTOP_MANAGED="1",
        OTEL_SDK_DISABLED="true",
        PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1",
        TMP=str(temporary),
        TEMP=str(temporary),
    )
    environment.pop("ASTRBOT_RESET_DASHBOARD_PASSWORD", None)
    environment.pop("ASTRBOT_DASHBOARD_INITIAL_PASSWORD", None)
    environment.pop("ASTRBOT_DESKTOP_SESSION_SECRET", None)
    log_path = runtime / "core.log"
    kwargs = {}
    if os.name == "nt":
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        kwargs.update(startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        kwargs["start_new_session"] = True
    with log_path.open("ab") as log:
        child = subprocess.Popen(
            [str(python), "-u", str(root / "main.py"), "--webui-dir", str(webui)],
            cwd=root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            **kwargs,
        )
    state = {
        "pid": child.pid,
        "created_at": psutil.Process(child.pid).create_time(),
        "url": url,
        "data_root": str(local),
        "log": str(log_path),
        "credentials": str(credential_path),
    }
    state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    deadline = time.monotonic() + args.wait
    while time.monotonic() < deadline:
        if child.poll() is not None:
            print(json.dumps({"running": False, "error": "startup_failed", **state}))
            return 1
        try:
            with urlopen(url, timeout=2) as response:
                if response.status == 200:
                    print(json.dumps({"running": True, "reachable": True, **state}))
                    return 0
        except (OSError, URLError):
            time.sleep(1)
    print(
        json.dumps(
            {"running": True, "reachable": False, "error": "startup_timeout", **state}
        )
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
