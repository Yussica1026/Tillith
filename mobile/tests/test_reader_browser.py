"""Exercise the built reader offline using only synthetic documents."""

import io
import mimetypes
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from PIL import Image
from playwright.sync_api import expect, sync_playwright

DIST = Path(__file__).resolve().parents[1] / "dist"
BASE = "http://127.0.0.1:54329"


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(channel="msedge", headless=True)
        yield instance
        instance.close()


def open_workspace(page):
    page.get_by_role("navigation", name="主导航").get_by_role("button", name="更多").click()
    page.get_by_role("button", name="共读 阅读、书签与批注").click()
    expect(page.get_by_role("heading", name="一起读书")).to_be_visible()


@pytest.fixture
def reader(browser):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")

    def local_bundle(route):
        url = urlsplit(route.request.url)
        if url.netloc != urlsplit(BASE).netloc or url.path.startswith("/api/"):
            route.abort()
            return
        asset = (DIST / (url.path.lstrip("/") or "index.html")).resolve()
        if not asset.is_relative_to(DIST) or not asset.is_file():
            route.abort()
            return
        mime = "application/javascript" if asset.suffix in (".js", ".mjs") else mimetypes.guess_type(asset.name)[0]
        route.fulfill(path=asset, content_type=mime or "application/octet-stream")

    context.route("**/*", local_bundle)
    page = context.new_page()
    page.goto(BASE, wait_until="networkidle")
    open_workspace(page)
    yield page
    context.close()


@pytest.mark.parametrize(
    ("encoding", "text"),
    [
        ("gbk", "今天的天气十分晴朗，山上的小鸟在树枝上唱歌。"),
        ("big5", "今天的天氣十分晴朗，山上的小鳥在樹枝上唱歌。"),
        ("gb18030", "四字节编码里的文字𠀀。"),
        ("utf-16", "明天再见，沿途有雨。"),
    ],
)
def test_reader_encodings(reader, encoding, text):
    reader.get_by_label("导入书籍").set_input_files({"name": "example.txt", "mimeType": "text/plain", "buffer": (text * 12).encode(encoding)})
    expect(reader.locator(".reader-body")).to_contain_text(text)


def test_reader_remembers_marks(reader):
    reader.get_by_label("导入书籍").set_input_files({"name": "chapters.md", "mimeType": "text/markdown", "buffer": ("小河边的故事。" * 600).encode()})
    reader.get_by_role("button", name="下一页").click()
    reader.get_by_role("button", name="添加书签").click()
    reader.get_by_role("button", name="写批注").click()
    reader.get_by_label("第 2 页批注").fill("合成批注")
    reader.get_by_role("button", name="保存批注").click()
    expect(reader.get_by_role("dialog")).to_have_count(0)
    reader.reload(wait_until="networkidle")
    open_workspace(reader)
    reader.get_by_label("本机书架").select_option(label="chapters.md")
    expect(reader.locator(".reader-paper small")).to_contain_text("第 2 /")
    reader.get_by_text("书签与批注（2）").click()
    expect(reader.get_by_text("合成批注", exact=True)).to_be_visible()


def test_reader_text_pdf_by_signature(reader):
    content = b"BT /F1 14 Tf 30 100 Td (Synthetic text layer) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    document = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(document))
        document.extend(b"%d 0 obj\n" % index + obj + b"\nendobj\n")
    xref = len(document)
    document.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(b"%010d 00000 n \n" % offset)
    document.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % xref)
    reader.get_by_label("导入书籍").set_input_files({"name": "without-extension", "mimeType": "application/octet-stream", "buffer": bytes(document)})
    expect(reader.locator(".reader-body")).to_contain_text("Synthetic text layer")


def test_reader_rejects_scanned_pdf(reader):
    output = io.BytesIO()
    Image.new("RGB", (120, 80), "gray").save(output, format="PDF")
    reader.get_by_label("导入书籍").set_input_files({"name": "scan.pdf", "mimeType": "application/pdf", "buffer": output.getvalue()})
    expect(reader.get_by_role("alert")).to_contain_text("没有可提取的文字层")
    expect(reader.get_by_role("button", name="问这一页")).to_have_count(0)


@pytest.mark.parametrize("data", [b"PK\x03\x04Example EPUB", bytes(60) + b"BOOKMOBI", b"index\x00\x01\x02data"])
def test_reader_rejects_binary_containers(reader, data):
    reader.get_by_label("导入书籍").set_input_files({"name": "renamed.txt", "mimeType": "text/plain", "buffer": data})
    expect(reader.get_by_role("alert")).to_be_visible()
    expect(reader.get_by_role("button", name="问这一页")).to_have_count(0)
