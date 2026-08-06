import json

from ..llm import call_model, parse_json
from .experts import REWRITE_STYLE_RULES


SYSTEM = """你是内容流水线的「规划大脑」。
你负责理解创作目标与素材，制定内容策略，并交给一名「洗稿编辑」完整改写。
只输出 JSON，不要输出任何解释或 Markdown。
JSON 结构：
{
  "title": "内容标题",
  "audience": "目标读者",
  "structure": [
    {"heading": "小节标题", "purpose": "这一节要达成的目的"}
  ],
  "expert_tasks": [
    {
      "id": "expert_1",
      "role": "洗稿编辑",
      "section": "全文",
      "instructions": "给洗稿编辑的完整改写指令"
    }
  ],
  "review_criteria": ["评审维度1", "评审维度2"]
}
要求：structure 至少 3 个小节；小标题用自然语言或设问句，不用“一、二、三”编号；标题用自然语言完整句子，可带感情色彩；
expert_tasks 只包含 1 个洗稿任务，洗稿编辑负责把共享素材按 structure 完整改写成全文。"""

IMAGE_PLANNING_RULE = """
素材中的图片地址（图片：url1、url2）必须规划进正文相应位置，并交给洗稿编辑原样引用；
素材没有图片时，不要凭空编造图片。"""


def _default_tasks(plan: dict, preferred: dict | None = None) -> list[dict]:
    sections = plan.get("structure") or []
    headings = "、".join(
        section.get("heading", f"第{index + 1}节")
        for index, section in enumerate(sections)
    )
    instructions = f"把共享素材完整洗稿成一篇中文文章，正文依次覆盖：{headings or '完整内容'}。"
    if preferred and preferred.get("instructions"):
        instructions = f"{preferred['instructions']} 正文需完整覆盖规划中的所有小节。"
    return [
        {
            "id": "expert_1",
            "role": (preferred or {}).get("role") or "洗稿编辑",
            "section": "全文",
            "instructions": instructions,
        }
    ]


def normalize_plan(plan: dict) -> dict:
    plan.setdefault("title", "未命名内容")
    plan.setdefault("audience", "目标读者")
    plan.setdefault("structure", [])
    plan.setdefault("review_criteria", ["信息量", "结构", "可读性"])
    tasks = plan.get("expert_tasks") or []
    plan["expert_tasks"] = _default_tasks(plan, tasks[0] if tasks else None)
    return plan


def planner_node(state: dict) -> dict:
    request = state["request"]
    user = json.dumps(
        {
            "创作目标": request.get("goal"),
            "目标平台": request.get("platform"),
            "语气": request.get("tone"),
            "目标字数": request.get("word_count"),
            "素材": request.get("source_material", ""),
        },
        ensure_ascii=False,
        indent=2,
    )
    raw = call_model(
        SYSTEM + IMAGE_PLANNING_RULE + REWRITE_STYLE_RULES,
        user,
        state["config"],
    )
    plan = normalize_plan(parse_json(raw))
    return {"plan": plan, "expert_tasks": plan["expert_tasks"]}
