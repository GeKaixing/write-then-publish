import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.rss import RSSError, compose_source, fetch_rss


RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>测试源</title>
    <item>
      <title>第一条 &lt;b&gt;加粗&lt;/b&gt; 新闻</title>
      <link>https://example.com/1</link>
      <pubDate>Wed, 02 Aug 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>这是一段<b>摘要</b>。</p>]]></description>
      <author>测试作者</author>
      <enclosure url="https://example.com/cover.jpg" type="image/jpeg" />
      <media:content url="https://example.com/media-1.jpg" />
      <media:thumbnail url="https://example.com/thumb-1.jpg" />
      <media:group>
        <media:content url="https://example.com/group-1.jpg" />
      </media:group>
    </item>
    <item>
      <title>第二条新闻</title>
      <link>https://example.com/2</link>
      <pubDate>Thu, 03 Aug 2026 08:30:00 GMT</pubDate>
      <description>第二条摘要</description>
    </item>
  </channel>
</rss>
"""

ATOM_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试源</title>
  <entry>
    <title>Atom 条目标题</title>
    <link href="https://example.com/atom/1" />
    <link rel="enclosure" href="https://example.com/atom-cover.png" />
    <updated>2026-08-03T09:00:00Z</updated>
    <summary>Atom 摘要内容</summary>
    <author><name>Atom 作者</name></author>
  </entry>
</feed>
"""

EMPTY_XML = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>空源</title></channel></rss>
"""


class FeedHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {
            "/feed.xml": (200, "application/rss+xml", RSS_XML),
            "/atom.xml": (200, "application/atom+xml", ATOM_XML),
            "/bad.xml": (200, "text/xml", "这不是 XML"),
            "/empty.xml": (200, "application/rss+xml", EMPTY_XML),
        }
        if self.path in routes:
            status, content_type, body = routes[self.path]
            body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/missing":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(400)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def feed_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FeedHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join(timeout=2)


def test_fetch_rss_parses_rss2(feed_server):
    items = fetch_rss(f"{feed_server}/feed.xml", limit=10)
    assert len(items) == 2
    first = items[0]
    assert first["title"] == "第一条 加粗 新闻"
    assert first["link"] == "https://example.com/1"
    assert first["published"] == "2026-08-02"
    assert first["summary"] == "这是一段 摘要 。"
    assert first["author"] == "测试作者"
    assert first["image"] == "https://example.com/cover.jpg"
    assert first["images"] == [
        "https://example.com/cover.jpg",
        "https://example.com/media-1.jpg",
        "https://example.com/thumb-1.jpg",
        "https://example.com/group-1.jpg",
    ]
    assert items[1]["image"] == ""
    assert items[1]["images"] == []


def test_fetch_rss_parses_atom(feed_server):
    items = fetch_rss(f"{feed_server}/atom.xml", limit=5)
    assert len(items) == 1
    entry = items[0]
    assert entry["title"] == "Atom 条目标题"
    assert entry["link"] == "https://example.com/atom/1"
    assert entry["published"] == "2026-08-03"
    assert entry["summary"] == "Atom 摘要内容"
    assert entry["author"] == "Atom 作者"
    assert entry["image"] == "https://example.com/atom-cover.png"
    assert entry["images"] == ["https://example.com/atom-cover.png"]


def test_fetch_rss_respects_limit(feed_server):
    items = fetch_rss(f"{feed_server}/feed.xml", limit=1)
    assert len(items) == 1
    assert items[0]["title"] == "第一条 加粗 新闻"


def test_fetch_rss_rejects_invalid_xml(feed_server):
    with pytest.raises(RSSError, match="XML"):
        fetch_rss(f"{feed_server}/bad.xml")


def test_fetch_rss_empty_feed(feed_server):
    with pytest.raises(RSSError, match="没有可用条目"):
        fetch_rss(f"{feed_server}/empty.xml")


def test_fetch_rss_http_error(feed_server):
    with pytest.raises(RSSError, match="HTTP 404"):
        fetch_rss(f"{feed_server}/missing")


def test_fetch_rss_rejects_bad_url():
    with pytest.raises(RSSError, match="http/https"):
        fetch_rss("javascript:alert(1)")
    with pytest.raises(RSSError, match="不能为空"):
        fetch_rss("")


def test_compose_source_merges_manual_and_rss():
    items = [
        {
            "title": "RSS 标题",
            "link": "https://example.com/rss",
            "published": "2026-08-03",
            "summary": "摘要",
            "image": "https://example.com/cover.jpg",
            "images": ["https://example.com/cover.jpg", "https://example.com/media-1.jpg"],
        }
    ]
    combined = compose_source("手动素材", items)
    assert "手动素材" in combined
    assert "## RSS 自动素材" in combined
    assert "RSS 标题" in combined
    assert "https://example.com/rss" in combined
    assert "2026-08-03" in combined
    assert "图片：https://example.com/cover.jpg、https://example.com/media-1.jpg" in combined


def test_rss_preview_api(monkeypatch):
    from app import main

    items = [{"title": "接口条目", "link": "https://example.com/feed/1", "published": "", "summary": "接口摘要", "author": ""}]
    monkeypatch.setattr(main, "fetch_rss", lambda url, limit: items)
    client = TestClient(main.app)
    response = client.get("/api/rss/preview", params={"url": "https://example.com/feed.xml", "limit": 8})
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["items"][0]["title"] == "接口条目"


def test_rss_preview_api_error(monkeypatch):
    from app import main

    def fail(url, limit):
        raise RSSError("RSS 地址不能为空")

    monkeypatch.setattr(main, "fetch_rss", fail)
    client = TestClient(main.app)
    response = client.get("/api/rss/preview", params={"url": "https://example.com/feed.xml"})
    assert response.status_code == 400
    assert "不能为空" in response.json()["detail"]


def test_image_proxy_success(monkeypatch):
    from app import main

    class FakeResponse:
        headers = SimpleNamespace(get_content_type=lambda: "image/jpeg")

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b"fake-image-bytes"

    monkeypatch.setattr(main.urllib.request, "urlopen", lambda request, timeout: FakeResponse())
    client = TestClient(main.app)
    response = client.get("/api/image", params={"url": "https://example.com/a.png"})
    assert response.status_code == 200
    assert response.content == b"fake-image-bytes"
    assert response.headers["content-type"] == "image/jpeg"


def test_image_proxy_rejects_bad_url():
    from app import main

    client = TestClient(main.app)
    response = client.get("/api/image", params={"url": "file:///etc/passwd"})
    assert response.status_code == 400
    assert "http/https" in response.json()["detail"]


def test_run_job_uses_rss_items_without_fetch(monkeypatch, request_payload):
    from app.jobs import run_job, store

    def should_not_fetch(url, limit):
        raise AssertionError("不应再次抓取 RSS")

    monkeypatch.setattr("app.jobs.fetch_rss", should_not_fetch)
    request_payload["rss_url"] = "https://example.com/feed.xml"
    request_payload["rss_items"] = [
        {"title": "勾选条目", "link": "https://example.com/feed/1", "published": "2026-08-03", "summary": "勾选摘要", "author": ""}
    ]
    job = store.create(request_payload, {"provider": "demo", "api_key": "", "model": "local-demo"})
    run_job(job["id"])

    detail = store.get(job["id"])
    assert detail["status"] == "completed"
    rss_events = [event for event in detail["events"] if event["type"] == "rss"]
    assert rss_events[-1]["status"] == "ok"
    assert rss_events[-1]["count"] == 1
    assert "勾选条目" in detail["request"]["source_material"]
    assert "勾选条目" in detail["result"]["markdown"]


def test_run_job_fetches_rss_when_no_items(monkeypatch, request_payload):
    from app.jobs import run_job, store

    items = [
        {"title": "自动抓取条目", "link": "https://example.com/feed/2", "published": "2026-08-03", "summary": "自动摘要", "author": ""}
    ]
    monkeypatch.setattr("app.jobs.fetch_rss", lambda url, limit: items)
    request_payload["rss_url"] = "https://example.com/feed.xml"
    job = store.create(request_payload, {"provider": "demo", "api_key": "", "model": "local-demo"})
    run_job(job["id"])

    detail = store.get(job["id"])
    assert detail["status"] == "completed"
    events = [event for event in detail["events"] if event["type"] == "rss"]
    assert [event["status"] for event in events] == ["fetching", "ok"]
    assert "自动抓取条目" in detail["request"]["source_material"]


def test_run_job_records_rss_error_and_continues(monkeypatch, request_payload):
    from app.jobs import run_job, store

    def fail(url, limit):
        raise RSSError("RSS 抓取失败：HTTP 503")

    monkeypatch.setattr("app.jobs.fetch_rss", fail)
    request_payload["rss_url"] = "https://example.com/feed.xml"
    job = store.create(request_payload, {"provider": "demo", "api_key": "", "model": "local-demo"})
    run_job(job["id"])

    detail = store.get(job["id"])
    assert detail["status"] == "completed"
    events = [event for event in detail["events"] if event["type"] == "rss"]
    assert events[-1]["status"] == "error"
    assert "RSS 抓取失败" in detail["request"]["source_material"]
