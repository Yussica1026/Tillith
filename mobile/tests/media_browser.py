"""Run against the local Vite dev server. All media and accounts are synthetic."""

import base64
import io
import os
import sys
import wave

from playwright.sync_api import expect, sync_playwright


def wave_bytes():
    out = io.BytesIO()
    with wave.open(out, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8000)
        stream.writeframes(bytes(8000 * 2 * 8))
    return out.getvalue()


def main():
    base = sys.argv[1].rstrip("/") + "/tests/media-fixture.html"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="msedge" if os.name == "nt" else None, headless=True
        )
        page = browser.new_page(viewport={"width": 390, "height": 844})
        posts = []
        page.on("request", lambda req: posts.append(req.method) if req.method == "POST" else None)
        page.goto(base)
        page.wait_for_load_state("networkidle")
        files = page.locator("input[type=file]")
        expect(files.first).to_be_enabled()
        encoded = page.evaluate("""async () => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
          const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(12);
          const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
          const chunks = []; recorder.ondataavailable = e => chunks.push(e.data);
          const stopped = new Promise(resolve => recorder.onstop = resolve);
          recorder.start(); const timer = setInterval(() => { ctx.fillStyle = '#124'; ctx.fillRect(0,0,48,48); }, 60);
          await new Promise(resolve => setTimeout(resolve, 900));
          recorder.stop(); await stopped; clearInterval(timer); stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(chunks); return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
        }""")
        files.first.set_input_files({"name": "scene.webm", "mimeType": "video/webm", "buffer": base64.b64decode(encoded)})
        page.wait_for_function("document.querySelector('video')?.readyState >= 1")
        srt = "1\n00:00:00,000 --> 00:00:00,400\nfirst scene\n\n2\n00:00:10,000 --> 00:00:15,000\nfuture scene"
        files.nth(1).set_input_files({"name":"scene.srt", "mimeType":"text/plain", "buffer":srt.encode()})
        expect(page.get_by_text("first scene", exact=True)).to_be_visible()
        page.get_by_label("问这一幕").fill("What did they say?")
        page.get_by_role("button", name="发送到作品对话").click()
        sent = page.evaluate("questions[0]")
        assert sent[0] == "film" and "first scene" in sent[3] and "future scene" not in sent[3]
        assert sum(len(str(value)) for value in sent) < 600
        page.reload()
        expect(page.get_by_text("first scene", exact=True)).to_be_visible()
        vtt = "WEBVTT\n\n00:00.000 --> 00:00.500 align:start\n<i>VTT scene</i>"
        files.nth(1).set_input_files({"name":"scene.vtt", "mimeType":"text/vtt", "buffer":vtt.encode()})
        expect(page.get_by_text("VTT scene", exact=True)).to_be_visible()
        page.route("**/synthetic-clip.webm", lambda route: route.fulfill(
            content_type="video/webm", body=base64.b64decode(encoded)))
        page.get_by_text("添加视频直链", exact=True).click()
        page.get_by_label("影片名称").fill("Synthetic link")
        page.get_by_label("视频直链").fill(sys.argv[1].rstrip("/") + "/synthetic-clip.webm")
        page.get_by_role("button", name="添加影片").click()
        page.wait_for_function("document.querySelector('video')?.currentSrc.endsWith('synthetic-clip.webm') && document.querySelector('video').readyState >= 1")
        page.goto(base + "?account=other")
        expect(page.get_by_text("选择一部影片，再添加 SRT 或 VTT 字幕。")).to_be_visible()

        page.goto(base + "?kind=music")
        expect(files.first).to_be_enabled()
        page.get_by_text("新建歌单", exact=True).click()
        page.get_by_label("歌单名称").fill("Playlist B")
        page.get_by_role("button", name="创建歌单").click()
        tracks = [{"name": name + ".wav", "mimeType": "audio/wav", "buffer": wave_bytes()} for name in ("one", "two")]
        files.first.set_input_files(tracks)
        page.wait_for_function("document.querySelector('audio')?.readyState >= 1")
        lrc = "[offset:250]\n[00:00.25]opening\n[00:03.25][00:05.25]chorus\n[00:07.00]secret ending"
        files.nth(1).set_input_files({"name":"one.lrc", "mimeType":"text/plain", "buffer":lrc.encode()})
        expect(page.get_by_text("opening", exact=True)).to_be_visible()
        page.evaluate("document.querySelector('audio').currentTime = 4")
        expect(page.get_by_text("chorus", exact=True)).to_be_visible()
        page.get_by_label("聊聊这首歌").fill("What lyric just played?")
        page.get_by_role("button", name="发送到作品对话").click()
        context = page.evaluate("questions[0][3]")
        assert "00:03 chorus" in context and "secret ending" not in context and "00:05" not in context
        page.reload()
        page.wait_for_function("Math.abs(document.querySelector('audio')?.currentTime - 4) < .1")
        expect(page.get_by_text("chorus", exact=True)).to_be_visible()
        assert page.evaluate("navigator.mediaSession.metadata.title") == "one.wav"
        page.evaluate("actions.nexttrack({action:'nexttrack'})")
        page.wait_for_function("navigator.mediaSession.metadata?.title === 'two.wav'")
        page.evaluate("actions.previoustrack({action:'previoustrack'})")
        page.wait_for_function("navigator.mediaSession.metadata?.title === 'one.wav'")
        page.evaluate("""async () => {
          const audio = document.querySelector('audio'); audio.currentTime = audio.duration - .1;
          await audio.play();
        }""")
        page.wait_for_function("navigator.mediaSession.metadata?.title === 'two.wav'")
        page.get_by_label("歌单", exact=True).select_option(label="我的歌单")
        expect(page.get_by_text("先向这个歌单添加歌曲。每首歌可以配一份 LRC 歌词。")).to_be_visible()
        assert not posts
        browser.close()
    print("PASS media: local and linked WebM, SRT/VTT, two WAVs, LRC, progress, playlists, account isolation, media actions, automatic advance, zero uploads")


if __name__ == "__main__":
    main()
