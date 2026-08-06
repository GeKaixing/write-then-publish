import json
import re

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama
from langchain_openai import ChatOpenAI


DEMO_SENTENCES = [
    "先从一个读者能立刻感知的具体场景切入，再逐步展开论证。",
    "这一节的核心不是堆砌信息，而是让读者看到一条清晰的逻辑线。",
    "结合目标平台的阅读习惯，把观点拆成短句和可记忆的要点。",
    "给出一个可执行的建议，让读者读完知道下一步该做什么。",
    "用案例或类比降低理解成本，避免只讲抽象概念。",
    "最后回到创作目标，确认这一段确实推进了整体表达。",
]


def _read_json(text: str) -> dict:
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {"raw": text}
    except json.JSONDecodeError:
        return {"raw": text}


def _demo_planner(user: str) -> str:
    data = _read_json(user)
    goal = data.get("创作目标") or "写一篇有信息增量的内容"
    platform = data.get("目标平台") or "通用"
    tone = data.get("语气") or "专业"
    source = (data.get("素材") or "").strip() or "本地演示素材：一个由规划大脑、洗稿编辑与评审组成的多 Agent 内容流水线。"
    title = f"{goal}｜{platform}实战"
    structure = [
        {"heading": "为什么需要多 Agent", "purpose": "说明单次生成的局限，引出分工协作"},
        {"heading": "流水线怎么分工", "purpose": "介绍规划大脑、洗稿编辑与质量评审的职责"},
        {"heading": "落地到日常创作", "purpose": "给出可直接使用的创作流程建议"},
    ]
    expert_tasks = [
        {
            "id": "expert_1",
            "role": "洗稿编辑",
            "section": "全文",
            "instructions": f"用{tone}的语气，把素材完整洗稿成一篇适合{platform}的文章，正文覆盖规划中所有小节，素材要点：{source}",
        },
    ]
    return json.dumps(
        {
            "title": title,
            "audience": f"对「{goal}」感兴趣的{platform}读者",
            "structure": structure,
            "expert_tasks": expert_tasks,
            "review_criteria": ["信息量", "结构", "可读性", "平台适配"],
        },
        ensure_ascii=False,
    )


def _demo_expert(user: str) -> str:
    data = _read_json(user)
    goal = data.get("创作目标") or "写一篇有信息增量的内容"
    platform = data.get("目标平台") or "通用"
    plan = data.get("规划") or {}
    sections = plan.get("structure") or [{"heading": "正文", "purpose": ""}]
    target = max(200, min(800, int(data.get("目标字数") or 800)))
    summary = data.get("创作目标") or "先给读者一句话摘要，概括全文核心。"
    source = (data.get("素材") or "").strip() or "本地演示素材：素材直接交给洗稿编辑改写。"
    title = plan.get("title") or f"{goal}｜{platform}实战"
    lines = [f"# {title}", "", f"> {summary}", "", f"素材要点：{source}", ""]
    index = 0
    while len("".join(lines)) < target:
        section = sections[index % len(sections)]
        heading = section.get("heading") or "正文"
        if not lines or lines[-1] != f"## {heading}":
            lines.extend([f"## {heading}", ""])
        sentence = DEMO_SENTENCES[index % len(DEMO_SENTENCES)]
        if index > 0:
            sentence = f"另一方面，{sentence}"
        lines.append(sentence)
        index += 1
    return "\n\n".join(lines)


def _demo_reviewer(user: str) -> str:
    data = _read_json(user)
    criteria = data.get("评审标准") or ["信息量", "结构", "可读性"]
    combined = data.get("草稿") or ""
    word_count = len(re.sub(r"\s", "", combined))
    scores = {item: (8 if word_count >= 160 else 6) for item in criteria}
    issues = [] if word_count >= 160 else ["草稿长度偏短，细节还不够充分"]
    verdict = "pass" if word_count >= 160 else "revise"
    return json.dumps(
        {
            "verdict": verdict,
            "scores": scores,
            "issues": issues,
            "suggestions": ["补充具体案例", "强化小节之间的承接"],
            "summary": "本地演示评审：结构完整，可以继续。",
        },
        ensure_ascii=False,
    )


def _demo_revise(user: str) -> str:
    data = _read_json(user)
    draft = data.get("当前草稿") or ""
    return (
        draft.strip()
        + "\n\n> 修订说明：已补充具体案例与承接句，确保每一节都回应创作目标。\n"
    )


def demo_call(system: str, user: str, config: dict) -> str:
    if "规划大脑" in system:
        return _demo_planner(user)
    if "质量控制评审" in system:
        return _demo_reviewer(user)
    if "修订编辑" in system:
        return _demo_revise(user)
    if "洗稿编辑" in system:
        return _demo_expert(user)
    raise ValueError(f"演示模式无法识别节点：{system[:40]}")


def build_model(config: dict):
    provider = config.get("provider", "openai_compatible")
    model = config.get("model", "gpt-4o-mini")
    temperature = float(config.get("temperature", 0.7))
    if provider == "demo":
        raise ValueError("演示模式不需要构建真实模型")
    if provider == "ollama":
        return ChatOllama(
            model=model,
            base_url=config.get("base_url") or "http://127.0.0.1:11434",
            temperature=temperature,
        )
    return ChatOpenAI(
        model=model,
        base_url=config.get("base_url") or None,
        api_key=config.get("api_key") or None,
        temperature=temperature,
    )


def call_model(system: str, user: str, config: dict) -> str:
    if config.get("provider") == "demo":
        return demo_call(system, user, config)
    model = config.get("_model") or build_model(config)
    response = model.invoke(
        [SystemMessage(content=system), HumanMessage(content=user)]
    )
    content = response.content
    return content if isinstance(content, str) else str(content)


def parse_json(text: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"模型没有返回 JSON：{text[:200]}")
    return json.loads(cleaned[start : end + 1])
