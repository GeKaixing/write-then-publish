import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from threading import Thread

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .jobs import run_job, store
from .models import AgentConfig, RunPayload, RunRequest
from .rss import RSSError, fetch_rss


app = FastAPI(title="文象 Agent Studio", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = Path.home() / ".config" / "write-then-publish-agent" / "config.json"


def load_config() -> AgentConfig:
    try:
        return AgentConfig(**json.loads(CONFIG_PATH.read_text("utf-8")))
    except Exception:
        return AgentConfig()


def save_config(config: AgentConfig):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(config.model_dump_json(indent=2), "utf-8")


def public_job(job: dict) -> dict:
    job = dict(job)
    config = dict(job.get("config") or {})
    if config.get("api_key"):
        config["api_key"] = "***"
    job["config"] = config
    return job


@app.get("/api/health")
def health():
    return {"ok": True, "service": "wtp-agent-backend"}


@app.get("/api/rss/preview")
def rss_preview(url: str, limit: int = 8):
    limit = min(max(int(limit), 1), 30)
    try:
        items = fetch_rss(url, limit=limit)
    except RSSError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"url": url, "count": len(items), "items": items}


@app.get("/api/image")
def image_proxy(url: str):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="图片地址必须是 http/https 链接")
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "write-then-publish-agent/0.1",
            "Accept": "image/*",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            content = response.read()
            media_type = response.headers.get_content_type() or "application/octet-stream"
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"图片抓取失败：HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(status_code=502, detail="图片抓取失败") from exc
    return Response(content=content, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.get("/api/config")
def get_config():
    return load_config()


@app.put("/api/config")
def put_config(config: AgentConfig):
    save_config(config)
    return config


@app.post("/api/runs")
def create_run(payload: RunPayload):
    request_data = RunRequest(**payload.model_dump(exclude={"config"})).model_dump()
    config_data = (payload.config or load_config()).model_dump()
    job = store.create(request_data, config_data)
    Thread(target=run_job, args=(job["id"],), daemon=True).start()
    return public_job(job)


@app.get("/api/runs")
def list_runs():
    return store.list()


@app.delete("/api/runs")
def clear_runs():
    cleared = store.clear()
    return {"ok": True, "cleared": cleared}


@app.get("/api/runs/{job_id}")
def get_run(job_id: str):
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    return public_job(job)


@app.get("/api/runs/{job_id}/events")
async def run_events(job_id: str):
    if not store.get(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")

    async def event_stream():
        sent = 0
        while True:
            job = store.get(job_id)
            events = job["events"]
            while sent < len(events):
                event = events[sent]
                sent += 1
                yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if job["status"] in ("completed", "failed") and sent >= len(events):
                break
            await asyncio.sleep(0.2)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent.parent
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
