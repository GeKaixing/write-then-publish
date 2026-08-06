import json

from ..llm import call_model, parse_json


REVIEWER_SYSTEM = """你是内容流水线的「质量控制评审」。
请对照规划标准审查草稿，判断是否通过。
只输出 JSON，结构：
{
  "verdict": "pass 或 revise",
  "scores": {"信息量": 8, "结构": 9, "可读性": 7},
  "issues": ["具体问题"],
  "suggestions": ["具体修改建议"],
  "summary": "一句话总评"
}
评审时额外检查：素材提供图片时，正文是否保留了原图引用（![描述](原图URL)），且没有编造图片地址。"""

REWRITE_CHECK_RULE = """
评审时还要对照 Futurism 洗稿技能风格：不要直译、约 500-800 字、开头一句话摘要、短段落、自然语言小标题、文末不加互动引导或标签。"""

REVISE_SYSTEM = """你是内容流水线的「修订编辑」。
根据评审意见修订全文，保留写得好的部分，直接输出修订后的完整 Markdown，
不要输出解释、清单或前后对照。
修订时保留素材提供的原图引用（![描述](原图URL)），不要删除或编造图片地址。
同时遵守 Futurism 洗稿技能风格：开头一句话摘要、短段落、自然语言小标题、文末不加互动引导或标签。"""


def reviewer_node(state: dict) -> dict:
    plan = state.get("plan") or {}
    user = json.dumps(
        {
            "规划": plan,
            "评审标准": plan.get("review_criteria", []),
            "草稿": state.get("combined", ""),
            "目标平台": state.get("request", {}).get("platform"),
        },
        ensure_ascii=False,
        indent=2,
    )
    raw = call_model(REVIEWER_SYSTEM + REWRITE_CHECK_RULE, user, state["config"])
    review = parse_json(raw)
    review["verdict"] = "pass" if review.get("verdict") == "pass" else "revise"
    return {"review": review}


def revise_node(state: dict) -> dict:
    user = json.dumps(
        {
            "规划": state.get("plan"),
            "评审意见": state.get("review"),
            "当前草稿": state.get("combined", ""),
        },
        ensure_ascii=False,
        indent=2,
    )
    content = call_model(REVISE_SYSTEM, user, state["config"])
    return {"combined": content.strip() + "\n", "revisions": state.get("revisions", 0) + 1}
