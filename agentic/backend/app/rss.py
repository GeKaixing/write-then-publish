import html
import re
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree


DEFAULT_TIMEOUT = 12
MAX_SUMMARY_CHARS = 320


class RSSError(RuntimeError):
    pass


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _children(node, local_name: str) -> list:
    return [child for child in node if _localname(child.tag) == local_name]


def _child_text(node, local_names: set) -> str:
    for child in node:
        if _localname(child.tag) in local_names and child.text and child.text.strip():
            return child.text.strip()
    return ""


def _descendant_text(node, path: list[str]) -> str:
    for child in node:
        if _localname(child.tag) == path[0]:
            if len(path) == 1:
                if child.text and child.text.strip():
                    return child.text.strip()
            else:
                found = _descendant_text(child, path[1:])
                if found:
                    return found
    return ""


def _collect_images(node) -> list[str]:
    urls = []

    def add(value):
        value = (value or "").strip()
        if value and value not in urls:
            urls.append(value)

    for child in node:
        tag = child.tag
        name = _localname(tag)
        namespace = tag[1 : tag.index("}")] if tag.startswith("{") else ""
        if name == "enclosure" and not namespace:
            add(child.get("url"))
            add(_child_text(child, {"url"}))
        elif name == "link" and (child.get("rel") or "").strip().lower() == "enclosure":
            add(child.get("href"))
            add(child.text)
        elif name in {"content", "thumbnail"} and namespace and namespace != "http://www.w3.org/2005/Atom":
            add(child.get("url"))
            add(child.get("src"))
            add(_child_text(child, {"url"}))
        elif name in {"group", "scene"} and namespace:
            for url in _collect_images(child):
                add(url)
    return urls


def _link_of(node) -> str:
    for child in node:
        if _localname(child.tag) == "link":
            href = child.get("href")
            if href:
                return href.strip()
            if child.text and child.text.strip():
                return child.text.strip()
    return ""


def _clean_html(value: str) -> str:
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_SUMMARY_CHARS] if len(text) > MAX_SUMMARY_CHARS else text


def _fmt_published(value: str) -> str:
    if not value:
        return ""
    try:
        return parsedate_to_datetime(value).astimezone().strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError):
        return value[:10]


def _parse_feed(root) -> list[dict]:
    entries = _children(root, "entry")
    if entries:
        return [_parse_atom_entry(entry) for entry in entries]
    channels = _children(root, "channel")
    if channels:
        return [_parse_rss_item(item) for item in _children(channels[0], "item")]
    return []


def _parse_rss_item(item) -> dict:
    summary = _clean_html(_child_text(item, {"description", "summary"}))
    images = _collect_images(item)
    return {
        "title": _clean_html(_child_text(item, {"title"})),
        "link": _link_of(item) or _clean_html(_child_text(item, {"guid"})),
        "published": _fmt_published(_child_text(item, {"pubDate", "date"})),
        "summary": summary,
        "author": _clean_html(
            _child_text(item, {"author", "creator"}) or _descendant_text(item, ["author", "name"])
        ),
        "image": images[0] if images else "",
        "images": images,
    }


def _parse_atom_entry(entry) -> dict:
    images = _collect_images(entry)
    return {
        "title": _clean_html(_child_text(entry, {"title"})),
        "link": _link_of(entry),
        "published": _fmt_published(_child_text(entry, {"published", "updated", "date"})),
        "summary": _clean_html(_child_text(entry, {"summary", "content"})),
        "author": _clean_html(
            _descendant_text(entry, ["author", "name"]) or _child_text(entry, {"author", "creator"})
        ),
        "image": images[0] if images else "",
        "images": images,
    }


def _validate_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise RSSError("RSS 地址不能为空")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RSSError("RSS 地址必须是 http/https 链接")
    return url


def fetch_rss(url: str, limit: int = 8) -> list[dict]:
    """抓取并解析 RSS/Atom 源，返回前 limit 条条目。"""
    url = _validate_url(url)
    limit = min(max(int(limit or 8), 1), 30)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "write-then-publish-agent/0.1",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise RSSError(f"RSS 抓取失败：HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None) or exc
        raise RSSError(f"RSS 抓取失败：{reason}") from exc
    except TimeoutError:
        raise RSSError("RSS 抓取超时，请检查地址或网络") from None

    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError:
        raise RSSError("返回内容不是有效的 XML，请确认这是 RSS/Atom 源") from None

    items = [item for item in _parse_feed(root) if item.get("title") or item.get("summary")]
    if not items:
        raise RSSError("RSS 源没有可用条目")
    return items[:limit]


def compose_source(manual: str, items: list[dict]) -> str:
    parts = []
    if manual and manual.strip():
        parts.append(manual.strip())
    if items:
        lines = ["## RSS 自动素材"]
        for index, item in enumerate(items, 1):
            lines.append(f"{index}. {item.get('title') or '未命名条目'}")
            if item.get("link"):
                lines.append(f"   链接：{item['link']}")
            if item.get("published"):
                lines.append(f"   时间：{item['published']}")
            if item.get("author"):
                lines.append(f"   作者：{item['author']}")
            images = item.get("images") or ([item["image"]] if item.get("image") else [])
            if images:
                lines.append(f"   图片：{'、'.join(images)}")
            if item.get("summary"):
                lines.append(f"   摘要：{item['summary']}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)
