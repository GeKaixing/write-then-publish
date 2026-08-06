import re

from langgraph.types import Send


def route_experts(state: dict) -> list[Send]:
    context = {
        "request": state.get("request"),
        "config": state.get("config"),
        "plan": state.get("plan"),
    }
    return [Send("expert", {**context, "task": task}) for task in state.get("expert_tasks", [])]


def route_review(state: dict) -> str:
    review = state.get("review") or {}
    max_revisions = int(state.get("request", {}).get("max_revisions", 2))
    if review.get("verdict") == "pass" or state.get("revisions", 0) >= max_revisions:
        return "finalize"
    return "revise"


def _extract_title(markdown: str) -> str:
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return ""


def finalize_node(state: dict) -> dict:
    request = state["request"]
    combined = state.get("combined", "")
    platform = request.get("platform", "通用")
    target_words = int(request.get("word_count", 1200))
    word_count = len(re.sub(r"\s", "", combined))
    title = _extract_title(combined) or "未命名内容"

    checklist = [
        {"label": "成稿已生成", "ok": bool(combined.strip())},
        {"label": "标题已提取", "ok": bool(_extract_title(combined))},
        {
            "label": f"字数接近 {target_words}",
            "ok": abs(word_count - target_words) <= max(150, int(target_words * 0.15)),
        },
        {
            "label": "适合当前平台",
            "ok": platform in {"小红书", "X", "公众号", "通用"},
        },
    ]
    final = {
        "title": title,
        "markdown": combined,
        "platform": platform,
        "word_count": word_count,
        "revisions": state.get("revisions", 0),
        "plan": {},
        "review": {},
        "checklist": checklist,
    }
    return {"final": final}
