"""Use the served bundle with synthetic accounts and intercepted APIs only."""

import json
import os
import sys
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright

BASE = os.getenv("TILLITH_TEST_ORIGIN", "http://127.0.0.1:6195")
if urlsplit(BASE).hostname != "127.0.0.1":
    raise ValueError("A loopback frontend is required")
cases = sys.argv[1:] or ["persona", "schedule", "life"]
people = [{"id": "a", "name": "样例甲"}, {"id": "b", "name": "样例乙"}]
records = {p["id"]: [] for p in people}
tool_selections = {"a": None, "b": None}
schedules = []
seen_private = []
errors = []


def intercept(route):
    req = route.request
    url = urlsplit(req.url)
    if url.hostname != "127.0.0.1":
        errors.append("external network")
        return route.abort()
    if not url.path.startswith("/api/"):
        return route.continue_()
    path = url.path.removeprefix("/api/v1")
    raw = req.post_data or ""
    if "fixture-secret-diary" in raw:
        seen_private.append(path)
    payload = json.loads(raw) if raw else {}
    data = {}
    if path == "/tillith/profile":
        data = {"app": "Tillith", "username": "synthetic"}
    elif path == "/chat/sessions":
        data = {
            "sessions": [{"session_id": "room", "display_name": "测试房间"}],
            "total": 1,
        }
    elif path == "/tillith/session-meta":
        data = {"items": [], "has_more": False}
    elif path == "/tillith/persona-options":
        data = {"personas": people}
    elif path == "/personas":
        data = [
            {
                "persona_id": p["id"],
                "system_prompt": "synthetic",
                "begin_dialogs": [],
                "tools": tool_selections[p["id"]],
                "folder_id": None,
                "sort_order": i,
            }
            for i, p in enumerate(people)
        ]
    elif path == "/personas/tree":
        data = []
    elif path.startswith("/tillith/persona-settings/"):
        data = {
            "persona_id": path.split("/")[-1],
            "display_name": "",
            "default_provider_id": None,
            "default_config_id": None,
        }
    elif path == "/tillith/chat-options":
        data = {"providers": [], "configs": [], "default_config_id": "default"}
    elif path == "/tillith/tools":
        data = {
            "tools": [
                {
                    "name": "inspect",
                    "active": True,
                    "readonly": False,
                    "origin": "mcp",
                    "origin_name": "catalog",
                }
            ]
        }
    elif path == "/tillith/mcp/servers":
        data = {
            "persona_tool_bindings": True,
            "servers": [
                {
                    "name": "catalog",
                    "active": True,
                    "connected": True,
                    "readonly": False,
                    "transport": "streamable_http",
                    "tools": ["inspect"],
                }
            ],
        }
    elif path == "/personas/by-id" and req.method == "PUT":
        tool_selections[payload["persona_id"]] = payload.get("tools")
    elif path == "/tillith/schedules" and req.method == "POST":
        schedules.append({"id": "job", **payload})
        data = schedules[-1]
    elif path == "/tillith/schedules":
        data = {"items": schedules}
    elif path == "/tillith/schedules/job" and req.method == "DELETE":
        schedules.clear()
    elif path.startswith("/tillith/life/"):
        person = path.split("/")[3]
        if req.method == "POST":
            data = {
                "id": str(len(records[person]) + 1),
                "persona_id": person,
                "author": "user",
                "parent_id": None,
                "day": "2026-01-01",
                "created_at": "2026-01-01T00:00:00Z",
                **payload,
            }
            records[person].append(data)
        else:
            data = {"items": records[person]}
    else:
        errors.append("unhandled " + req.method + " " + path)
        return route.fulfill(status=404, json={"status": "error"})
    route.fulfill(status=200, json={"status": "ok", "data": data})


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844}, service_workers="block"
    )
    ctx.route("**/*", intercept)
    page = ctx.new_page()
    page.set_default_timeout(6500)
    page.on("pageerror", lambda error: errors.append(str(error)[:180]))
    page.goto(BASE)
    page.get_by_role("button", name="设置连接", exact=False).first.click()
    page.get_by_label("服务器地址", exact=True).fill(BASE)
    page.get_by_label("API Key", exact=True).fill("synthetic")
    page.get_by_label("管理 API Key", exact=True).fill("synthetic-management")
    page.get_by_role("button", name="保存并连接", exact=True).click()
    expect(page.get_by_role("heading", name="会话", exact=True)).to_be_visible()
    failed = []
    for case in cases:
        try:
            page.get_by_role("navigation", name="主导航").get_by_role(
                "button", name="更多", exact=True
            ).click()
            if case == "persona":
                page.locator(".more-entry").filter(
                    has_text="人格、世界书与记忆"
                ).click()
                card = page.locator(".persona-card").filter(
                    has=page.get_by_role("heading", name="样例甲", exact=True)
                )
                card.get_by_role("button", name="编辑人格").click()
                chooser = page.get_by_role("dialog")
                chooser.get_by_label("可用工具范围").select_option("custom")
                chooser.get_by_role("checkbox", name="catalog", exact=True).check()
                chooser.get_by_role("button", name="保存人格").click()
                expect(chooser).not_to_be_visible()
                assert tool_selections["a"] == ["mcp:catalog"]
                card.get_by_role("button", name="编辑人格").click()
                expect(
                    chooser.get_by_role("checkbox", name="catalog", exact=True)
                ).to_be_checked()
                chooser.get_by_role("checkbox", name="catalog", exact=True).uncheck()
                chooser.get_by_role("checkbox", name="inspect · catalog").check()
                chooser.get_by_role("button", name="保存人格").click()
                expect(chooser).not_to_be_visible()
                assert (
                    tool_selections["a"] == ["mcp-tool:catalog/inspect"]
                    and tool_selections["b"] is None
                )
            if case == "schedule":
                page.locator(".more-entry").filter(has_text="定时留言").click()
                page.get_by_label("重复").select_option("daily")
                page.get_by_label("发送时间").fill("08:30")
                page.get_by_label("留言内容").fill("fixture daily note")
                page.get_by_role("button", name="保存定时留言").click()
                expect(
                    page.get_by_text("fixture daily note", exact=True)
                ).to_be_visible()
                assert (
                    schedules[0]["session_id"] == "room"
                    and schedules[0]["daily"] == "08:30"
                )
                page.get_by_role("button", name="取消此安排").click()
                expect(page.get_by_text("还没有定时留言。")).to_be_visible()
            if case == "life":
                page.locator(".more-entry").filter(has_text="生活簿").click()
                page.get_by_label("所属人格").select_option("a")
                page.get_by_role("button", name="写留言").click()
                page.get_by_label("正文").fill("fixture board")
                page.get_by_role("dialog").get_by_role(
                    "button", name="保存", exact=True
                ).click()
                expect(page.get_by_text("fixture board", exact=True)).to_be_visible()
                page.get_by_role("button", name="回复留言").click()
                page.get_by_label("正文").fill("fixture reply")
                page.get_by_role("dialog").get_by_role(
                    "button", name="保存", exact=True
                ).click()
                expect(page.get_by_text("fixture reply", exact=True)).to_be_visible()
                assert records["a"][1]["parent_id"] == records["a"][0]["id"]
                assert records["a"][0]["ai_visible"] is False
                page.get_by_label("所属人格").select_option("b")
                expect(
                    page.get_by_text("fixture board", exact=True)
                ).not_to_be_visible()
                page.get_by_role("button", name="共同日记", exact=True).click()
                page.get_by_role("button", name="写日记").click()
                page.get_by_label("正文").fill("fixture-secret-diary")
                page.get_by_role("dialog").get_by_role(
                    "button", name="保存", exact=True
                ).click()
                expect(
                    page.get_by_text("fixture-secret-diary", exact=True)
                ).to_be_visible()
                page.get_by_label("所属人格").select_option("a")
                expect(
                    page.get_by_text("fixture-secret-diary", exact=True)
                ).not_to_be_visible()
                page.get_by_label("所属人格").select_option("b")
                expect(
                    page.get_by_text("fixture-secret-diary", exact=True)
                ).to_be_visible()
                assert not seen_private and not records["b"]
            assert not errors, errors
            print("PASS", case, flush=True)
        except Exception as exc:
            failed.append(case)
            print("FAIL", case, str(exc)[:1400], errors, flush=True)
            if page.get_by_role("dialog").count():
                page.keyboard.press("Escape")
            errors.clear()
    browser.close()
    if failed:
        raise SystemExit(1)
