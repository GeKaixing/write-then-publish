import json
import threading
import time
import uuid
from pathlib import Path

from .graph import build_graph
from .rss import RSSError, compose_source, fetch_rss


DEFAULT_STORE_PATH = Path.home() / ".config" / "write-then-publish-agent" / "jobs.json"


class JobStore:
    def __init__(self, path: str | Path | None = None):
        self._jobs = {}
        self._lock = threading.Lock()
        self._path = None
        if path:
            self.set_path(path)

    def set_path(self, path: str | Path):
        with self._lock:
            self._path = Path(path)
            if self._path.exists():
                try:
                    data = json.loads(self._path.read_text("utf-8"))
                    self._jobs = data if isinstance(data, dict) else {}
                except (OSError, ValueError):
                    self._jobs = {}
            else:
                self._jobs = {}

    def clear(self) -> int:
        with self._lock:
            count = len(self._jobs)
            self._jobs = {}
            self._persist_locked()
            return count

    def _persist_locked(self):
        if not self._path:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(self._jobs, ensure_ascii=False, indent=2),
            "utf-8",
        )
        tmp.replace(self._path)

    def create(self, request: dict, config: dict) -> dict:
        with self._lock:
            job = {
                "id": uuid.uuid4().hex[:12],
                "status": "queued",
                "request": request,
                "config": config,
                "events": [{"type": "status", "status": "queued"}],
                "result": None,
                "error": None,
                "created_at": time.time(),
                "updated_at": time.time(),
            }
            self._jobs[job["id"]] = job
            self._persist_locked()
            return dict(job)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def append_event(self, job_id: str, event: dict):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job["events"].append(event)
                job["updated_at"] = time.time()
                self._persist_locked()

    def update_request(self, job_id: str, request: dict):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job["request"] = request
                job["updated_at"] = time.time()
                self._persist_locked()

    def complete(self, job_id: str, result: dict):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job["status"] = "completed"
                job["result"] = result
                job["updated_at"] = time.time()
                self._persist_locked()

    def fail(self, job_id: str, error: str):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job["status"] = "failed"
                job["error"] = error
                job["updated_at"] = time.time()
                self._persist_locked()

    def list(self) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        result = []
        for job in jobs:
            final = job.get("result") or {}
            result.append(
                {
                    "id": job["id"],
                    "status": job["status"],
                    "created_at": job["created_at"],
                    "updated_at": job.get("updated_at", job["created_at"]),
                    "error": job["error"],
                    "goal": job["request"].get("goal"),
                    "platform": job["request"].get("platform"),
                    "provider": job["config"].get("provider"),
                    "model": job["config"].get("model"),
                    "title": final.get("title"),
                }
            )
        return result


store = JobStore(DEFAULT_STORE_PATH)


def _merge_update(state: dict, update: dict):
    for key, value in update.items():
        if key == "drafts":
            state.setdefault("drafts", []).extend(value or [])
        else:
            state[key] = value


def run_job(job_id: str):
    job = store.get(job_id)
    if not job:
        return
    store.append_event(job_id, {"type": "status", "status": "running"})
    try:
        request = dict(job["request"])
        rss_url = (request.get("rss_url") or "").strip()
        rss_limit = int(request.get("rss_limit") or 8)
        rss_items = [
            dict(item) for item in (request.get("rss_items") or []) if isinstance(item, dict)
        ]
        if rss_items:
            store.append_event(
                job_id,
                {"type": "rss", "status": "ok", "count": len(rss_items), "url": rss_url},
            )
            request["source_material"] = compose_source(
                request.get("source_material", ""), rss_items
            )
        elif rss_url:
            store.append_event(job_id, {"type": "rss", "status": "fetching", "url": rss_url})
            try:
                rss_items = fetch_rss(rss_url, limit=rss_limit)
            except RSSError as exc:
                note = f"RSS 抓取失败：{exc}"
                manual = request.get("source_material", "").strip()
                request["source_material"] = f"{manual}\n\n{note}".strip() if manual else note
                store.append_event(
                    job_id,
                    {"type": "rss", "status": "error", "url": rss_url, "error": str(exc)},
                )
            else:
                store.append_event(
                    job_id,
                    {"type": "rss", "status": "ok", "count": len(rss_items), "url": rss_url},
                )
                request["source_material"] = compose_source(
                    request.get("source_material", ""), rss_items
                )
        store.update_request(job_id, request)

        graph = build_graph()
        initial = {"request": request, "config": job["config"]}
        merged = {}
        for chunk in graph.stream(
            initial,
            config={"recursion_limit": 30},
            stream_mode="updates",
        ):
            for node, update in chunk.items():
                store.append_event(
                    job_id, {"type": "node", "node": node, "data": _jsonable(update)}
                )
                _merge_update(merged, update)
        final = merged.get("final")
        if not final:
            raise RuntimeError("流水线没有产出 final 结果")
        store.append_event(job_id, {"type": "result", "result": final})
        store.complete(job_id, final)
    except Exception as exc:
        store.append_event(job_id, {"type": "error", "error": str(exc)})
        store.fail(job_id, str(exc))


def _jsonable(value):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        return {"note": "不可序列化数据"}
