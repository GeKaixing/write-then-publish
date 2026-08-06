from app.graph import build_graph


def run_pipeline(request_payload, agent_config):
    graph = build_graph()
    updates = []
    final = None
    for chunk in graph.stream(
        {"request": request_payload, "config": agent_config},
        config={"recursion_limit": 30},
        stream_mode="updates",
    ):
        updates.extend(chunk.keys())
        node_update = chunk.get("finalize")
        if node_update:
            final = node_update.get("final")
    return updates, final


def test_pipeline_produces_final_with_single_rewrite(
    fake_llm, request_payload, agent_config
):
    updates, final = run_pipeline(request_payload, agent_config)

    assert updates == ["expert", "finalize"]
    assert fake_llm["expert"] == 1
    assert final["title"] == "AI 写作流水线测试文"
    assert "开篇" in final["markdown"]
    assert "主体" in final["markdown"]
    assert "收尾" in final["markdown"]
    assert final["revisions"] == 0
    assert final["checklist"][0]["ok"] is True


def test_demo_provider_runs_single_rewrite_without_key(request_payload):
    updates, final = run_pipeline(
        request_payload,
        {
            "provider": "demo",
            "base_url": "",
            "api_key": "",
            "model": "local-demo",
            "temperature": 0.5,
        },
    )

    assert "planner" not in updates
    assert updates.count("expert") == 1
    assert updates.count("finalize") == 1
    assert final["title"]
    assert final["markdown"].startswith("# ")


def test_rewrite_style_rules_injected_into_prompt(
    monkeypatch, request_payload, agent_config
):
    import app.nodes.experts as experts

    system_prompts = []

    def recording_call(system, user, config):
        system_prompts.append(system)
        return "# 标题\n\n## 开篇\n正文。"

    monkeypatch.setattr(experts, "call_model", recording_call)

    updates, final = run_pipeline(request_payload, agent_config)

    assert len(system_prompts) == 1
    system = system_prompts[0]
    assert "洗稿编辑" in system
    assert "洗稿规范参考" in system
    assert "futurism-fetcher" in system
    assert "不是直译" in system
    assert "开头用一句话摘要" in system
    assert "不需要抓取 RSS" in system
    assert updates.count("expert") == 1
    assert final["title"] == "标题"


def test_pi_rewriter_used_for_rewrite(
    fake_llm, monkeypatch, request_payload, agent_config
):
    import app.nodes.experts as experts

    pi_calls = []

    def fake_pi(system, user, config):
        pi_calls.append(system)
        return "# Pi 洗稿标题\n\n## 开篇\nPi 洗稿正文。"

    monkeypatch.setattr(experts, "call_pi", fake_pi)
    config = {
        **agent_config,
        "rewrite_provider": "pi",
        "pi_provider": "opencode-go",
        "pi_tools": "read,grep,find,ls",
        "pi_skill": "~/.hermes/skills/futurism-fetcher",
    }
    updates, final = run_pipeline(request_payload, config)

    assert updates == ["expert", "finalize"]
    assert fake_llm["expert"] == 0
    assert fake_llm["planner"] == 0
    assert fake_llm["reviewer"] == 0
    assert len(pi_calls) == 1
    assert "洗稿编辑" in pi_calls[0]
    assert "Pi 洗稿正文" in final["markdown"]
