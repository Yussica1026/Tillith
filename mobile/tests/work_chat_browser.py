"""Exercise the real App work-to-chat flow with intercepted REST and WebSocket I/O."""

import json
import os
import re
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from media_browser import wave_bytes


class SyntheticCore:
    def __init__(self):
        self.sessions = {}
        self.history = {}
        self.sent = []
        self.unexpected = []
        self.hold_list = False
        self.held = None

    def reply(self, route, data):
        route.fulfill(json={"status": "ok", "data": data})

    def http(self, route):
        req = route.request
        path = urlsplit(req.url).path.removeprefix("/api/v1")
        if path == "/tillith/profile":
            data = {"app": "Tillith", "username": "fixture-owner"}
        elif path == "/chat/sessions":
            if self.hold_list:
                self.hold_list = False
                self.held = route
                return
            data = {"sessions": list(self.sessions.values()), "total": len(self.sessions)}
        elif path == "/chat/sessions/new":
            key = "fixture-" + str(len(self.sessions) + 1)
            self.sessions[key] = {"session_id": key, "display_name": "新的对话"}
            self.history[key] = []
            data = self.sessions[key]
        elif path.startswith("/chat/sessions/"):
            key = path.split("/")[-1]
            if req.method == "PATCH":
                self.sessions[key]["display_name"] = req.post_data_json["display_name"]
            data = {"session": self.sessions[key], "history": self.history[key], "active_runs": []}
        elif path == "/tillith/session-meta":
            data = {"items": [], "has_more": False}
        elif path.endswith("/context"):
            data = {"persona_id": None, "worldbook_ids": []}
        elif path == "/tillith/persona-options":
            data = {"personas": []}
        elif path == "/tillith/worldbooks":
            data = {"worldbooks": []}
        else:
            self.unexpected.append((req.method, path))
            route.fulfill(status=404, json={"status": "error"})
            return
        self.reply(route, data)

    def websocket(self, socket):
        def receive(raw):
            command = json.loads(raw)
            if command["t"] == "auth":
                assert command["api_key"] == "synthetic-work-chat"
                socket.send(json.dumps({"type": "auth_ok"}))
                return
            assert command["t"] == "send"
            parts = command["message"]
            assert len(parts) == 1 and set(parts[0]) == {"type", "text"} and parts[0]["type"] == "plain"
            key = command["session_id"]
            self.sent.append((key, parts[0]["text"]))
            self.history[key].append({"id": len(self.history[key]) + 1, "sender_id": "user", "content": {"type": "user", "message": parts}})
            for event in ({"type": "run_started", "data": {"run_id": "fixture-run"}},
                          {"type": "plain", "data": "fixture answer"}, {"type": "end"}):
                socket.send(json.dumps(event))
        socket.on_message(receive)


def main():
    base = sys.argv[1].rstrip("/")
    core = SyntheticCore()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge" if os.name == "nt" else None, headless=True)
        page = browser.new_page(service_workers="block", viewport={"width": 400, "height": 850})
        page.route("**/api/v1/**", core.http)
        page.route_web_socket("**/api/v1/tillith/chat/ws", core.websocket)
        page.goto(base); page.wait_for_load_state("networkidle")
        page.get_by_role("button", name="打开连接设置").click()
        page.get_by_placeholder("https://你的服务器地址").fill(base)
        page.get_by_placeholder("粘贴连接密钥").fill("synthetic-work-chat")
        page.locator(".settings-page form button[type=submit]").last.click()
        expect(page.get_by_role("button", name="刷新会话")).to_be_enabled()

        def workspace(kind):
            back = page.get_by_role("button", name="返回会话列表")
            if back.count():
                back.click()
            page.get_by_role("navigation", name="主导航").get_by_role("button", name="更多").click()
            page.get_by_role("button", name=re.compile("^" + kind)).click()

        def ask(label, question, title):
            count = len(core.sent)
            page.get_by_label(label, exact=True).fill(question)
            page.get_by_role("button", name="发送到作品对话").click()
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
            expect(page.locator(".chat-tools .model-picker")).to_be_enabled()
            assert len(core.sent) == count + 1
            assert question in core.sent[-1][1]
            return core.sent[-1]

        def library_files():
            return page.locator("main.media-workspace input[type=file]")

        workspace("共影")
        # Playback/codec behavior is covered by media_browser. This test exercises actual
        # player selection, captions, routing, App session persistence and outgoing frames.
        video = page.evaluate("""async () => {
          const canvas=document.createElement('canvas'); canvas.width=canvas.height=32;
          const stream=canvas.captureStream(10), rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
          const chunks=[]; rec.ondataavailable=e=>chunks.push(e.data); const end=new Promise(r=>rec.onstop=r);
          rec.start(); const tick=setInterval(()=>canvas.getContext('2d').fillRect(0,0,32,32),40);
          await new Promise(r=>setTimeout(r,400)); rec.stop(); await end; clearInterval(tick);
          stream.getTracks().forEach(t=>t.stop()); return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
        }""")
        films = [{"name": name + ".webm", "mimeType": "video/webm", "buffer": bytes(video)} for name in ("A", "B")]
        library_files().first.set_input_files(films)
        expect(library_files().nth(1)).to_be_enabled()
        captions = "1\n00:00:00,000 --> 00:00:00,500\nAVAILABLE A\n\n2\n00:01:00,000 --> 00:01:05,000\nFUTURE A"
        library_files().nth(1).set_input_files({"name": "a.srt", "mimeType": "text/plain", "buffer": captions.encode()})
        expect(page.get_by_text("AVAILABLE A", exact=True)).to_be_visible()
        assert not core.sessions and not core.sent
        a, message = ask("问这一幕", "Ask-A1", "共影 · A.webm")
        assert "AVAILABLE A" in message and "FUTURE A" not in message
        workspace("共影")
        again, _ = ask("问这一幕", "Ask-A2", "共影 · A.webm")
        assert again == a and len(core.sessions) == 1
        workspace("共影")
        films_select = page.locator(".media-select select")
        films_select.select_option(label="B.webm")
        b, message = ask("问这一幕", "Ask-B1", "共影 · B.webm")
        assert a != b and "AVAILABLE A" not in message

        workspace("共影"); films_select.select_option(label="A.webm")
        page.get_by_label("问这一幕", exact=True).fill("discard this stale question")
        core.hold_list = True
        with page.expect_request(lambda req: urlsplit(req.url).path == "/api/v1/chat/sessions"):
            page.get_by_role("button", name="发送到作品对话").click()
        films_select.select_option(label="B.webm")
        expect(library_files().nth(1)).to_be_enabled()
        assert core.held is not None
        with page.expect_response(lambda res: urlsplit(res.url).path == "/api/v1/chat/sessions"):
            core.reply(core.held, {"sessions": list(core.sessions.values()), "total": len(core.sessions)})
        expect(page.get_by_role("heading", name="一起看电影")).to_be_visible()
        again, _ = ask("问这一幕", "Ask-B2", "共影 · B.webm")
        assert again == b and len(core.sent) == 4
        assert all("discard this stale question" not in text for _, text in core.sent)

        workspace("听歌")
        library_files().first.set_input_files({"name":"song.wav", "mimeType":"audio/wav", "buffer":wave_bytes()})
        expect(library_files().nth(1)).to_be_enabled()
        library_files().nth(1).set_input_files({"name":"song.lrc", "mimeType":"text/plain", "buffer":b"[00:00.00]heard\n[00:30.00]unheard"})
        expect(page.get_by_text("heard", exact=True)).to_be_visible()
        song, message = ask("聊聊这首歌", "Ask-song", "听歌 · song.wav")
        assert song not in (a, b) and "heard" in message and "unheard" not in message

        workspace("共读")
        book = page.get_by_label("导入书籍")
        book.set_input_files({"name":"sample.txt", "mimeType":"text/plain", "buffer":b"First selected excerpt.\n" + b"local-only end of book\n" * 1000})
        # Ask through the reader's own form after local import.
        question = page.get_by_label("共读问题", exact=True)
        question.fill("Ask-book")
        page.get_by_role("button", name="问这一页", exact=True).click()
        expect(page.get_by_role("heading", name=re.compile("^共读 · sample"))).to_be_visible()
        expect(page.locator(".chat-tools .model-picker")).to_be_enabled()
        book_session, message = core.sent[-1]
        assert book_session not in (song, a, b) and "Ask-book" in message and "First selected excerpt." in message
        assert len(message) < 7000 and len(core.sessions) == 4 and len(core.sent) == 6
        assert not core.unexpected, core.unexpected
        browser.close()
    print("PASS App work chat: 4 distinct sessions, 6 explicit text-only messages, session reuse, spoiler cutoff, stale switch discarded, zero uploads")


if __name__ == "__main__":
    main()
