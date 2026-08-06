import json

import pytest

import app.nodes.experts as experts
import app.nodes.planner as planner
import app.nodes.reviewer as reviewer


PLAN = {
    "title": "AI 写作流水线测试文",
    "audience": "内容创作者",
    "structure": [
        {"heading": "开篇", "purpose": "点题"},
        {"heading": "主体", "purpose": "论证"},
        {"heading": "收尾", "purpose": "号召"},
    ],
    "expert_tasks": [
        {"id": "expert_1", "role": "洗稿编辑", "section": "全文", "instructions": "完整洗稿全文"},
    ],
    "review_criteria": ["信息量", "结构", "可读性"],
}

EXPERT_CONTENT = {
    "expert_1": "# AI 写作流水线测试文\n\n## 开篇\n开头要抓人。\n\n## 主体\n这里给出三个论据。\n\n## 收尾\n最后给行动建议。",
}


def make_review(verdict: str, summary: str) -> str:
    return json.dumps(
        {
            "verdict": verdict,
            "scores": {"信息量": 8, "结构": 8, "可读性": 8},
            "issues": [],
            "suggestions": [],
            "summary": summary,
        },
        ensure_ascii=False,
    )


@pytest.fixture
def fake_llm(monkeypatch):
    calls = {"planner": 0, "expert": 0, "reviewer": 0, "revise": 0}
    review_queue = [make_review("revise", "需要打磨"), make_review("pass", "可以发布")]

    def fake_call(system: str, user: str, config: dict) -> str:
        if "规划大脑" in system:
            calls["planner"] += 1
            return json.dumps(PLAN, ensure_ascii=False)
        if "洗稿编辑" in system:
            calls["expert"] += 1
            return EXPERT_CONTENT["expert_1"]
        if "质量控制评审" in system:
            calls["reviewer"] += 1
            return review_queue[min(calls["reviewer"] - 1, len(review_queue) - 1)]
        if "修订编辑" in system:
            calls["revise"] += 1
            data = json.loads(user)
            return data.get("当前草稿", "") + "\n\n> 已按评审意见修订。"
        raise AssertionError(f"未知系统提示词：{system[:40]}")

    monkeypatch.setattr(planner, "call_model", fake_call)
    monkeypatch.setattr(experts, "call_model", fake_call)
    monkeypatch.setattr(reviewer, "call_model", fake_call)
    return calls


@pytest.fixture
def request_payload():
    return {
        "source_material": "素材：LangGraph 适合编排多 agent。",
        "goal": "写一篇 AI 多 agent 介绍",
        "platform": "小红书",
        "tone": "轻松",
        "word_count": 800,
        "max_revisions": 2,
    }


@pytest.fixture
def agent_config():
    return {
        "provider": "openai_compatible",
        "base_url": "",
        "api_key": "test",
        "model": "fake-model",
        "temperature": 0.2,
    }


@pytest.fixture(autouse=True)
def isolated_job_store(tmp_path):
    from app.jobs import store

    store.set_path(tmp_path / "jobs.json")
    yield store
    store.clear()
