import time

from fastapi.testclient import TestClient

from app.main import app


def test_health():
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_create_and_list_run(monkeypatch, request_payload, agent_config):
    def fake_run(job_id):
        from app.jobs import store

        store.complete(
            job_id,
            {
                "title": "测试",
                "markdown": "# 测试",
                "platform": "小红书",
                "word_count": 4,
                "revisions": 0,
                "plan": {},
                "review": {"verdict": "pass"},
                "checklist": [],
            },
        )

    monkeypatch.setattr("app.main.run_job", fake_run)
    client = TestClient(app)
    response = client.post(
        "/api/runs",
        json={**request_payload, "config": agent_config},
    )
    assert response.status_code == 200
    job_id = response.json()["id"]

    runs = client.get("/api/runs").json()
    assert any(item["id"] == job_id for item in runs)

    detail = client.get(f"/api/runs/{job_id}").json()
    assert detail["status"] == "completed"
    assert detail["result"]["title"] == "测试"


def test_config_roundtrip(monkeypatch, tmp_path):
    from app import main

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    client = TestClient(app)

    payload = {
        "provider": "ollama",
        "base_url": "http://127.0.0.1:11434",
        "api_key": "",
        "model": "qwen2.5:7b",
        "temperature": 0.3,
    }
    saved = client.put("/api/config", json=payload).json()
    assert saved["model"] == "qwen2.5:7b"
    assert client.get("/api/config").json()["provider"] == "ollama"


def test_config_roundtrip_with_pi_rewrite(monkeypatch, tmp_path):
    from app import main

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    client = TestClient(app)

    payload = {
        "provider": "openai_compatible",
        "base_url": "https://opencode.ai/zen/go/v1",
        "api_key": "sk-test",
        "model": "deepseek-v4-flash",
        "temperature": 0.6,
        "rewrite_provider": "pi",
        "pi_provider": "opencode-go",
        "pi_tools": "read,grep,find,ls",
        "pi_skill": "~/.hermes/skills/futurism-fetcher",
    }
    saved = client.put("/api/config", json=payload).json()
    assert saved["rewrite_provider"] == "pi"
    assert saved["pi_provider"] == "opencode-go"
    assert client.get("/api/config").json()["pi_tools"] == "read,grep,find,ls"
    assert (
        client.get("/api/config").json()["pi_skill"]
        == "~/.hermes/skills/futurism-fetcher"
    )


def test_demo_run_completes_end_to_end(request_payload):
    client = TestClient(app)
    response = client.post(
        "/api/runs",
        json={**request_payload, "config": {"provider": "demo"}},
    )
    assert response.status_code == 200
    job_id = response.json()["id"]

    deadline = time.time() + 5
    detail = None
    while time.time() < deadline:
        detail = client.get(f"/api/runs/{job_id}").json()
        if detail["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)

    assert detail is not None
    assert detail["status"] == "completed"
    assert detail["result"]["markdown"]
    assert detail["config"]["api_key"] == ""

    with client.stream("GET", f"/api/runs/{job_id}/events") as response:
        body = response.read().decode("utf-8")
    assert '"node": "expert"' in body
    assert '"node": "finalize"' in body
    assert "event: result" in body


def test_job_store_persists_across_instances(tmp_path):
    from app.jobs import JobStore

    path = tmp_path / "jobs-persist.json"
    first = JobStore(path)
    job = first.create(
        {"goal": "持久化测试", "platform": "通用"},
        {"provider": "demo", "api_key": "", "model": "local-demo"},
    )
    first.complete(job["id"], {"title": "持久化标题", "markdown": "# 持久化"})

    second = JobStore(path)
    loaded = second.get(job["id"])
    assert loaded["status"] == "completed"
    assert loaded["result"]["title"] == "持久化标题"


def test_clear_runs():
    from app.jobs import store

    client = TestClient(app)
    store.create(
        {"goal": "待清理", "platform": "通用"},
        {"provider": "demo", "api_key": ""},
    )
    assert client.delete("/api/runs").json()["cleared"] == 1
    assert client.get("/api/runs").json() == []
