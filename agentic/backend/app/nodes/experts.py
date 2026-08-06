import json

from ..llm import call_model
from ..pi_agent import call_pi


REWRITE_STYLE_RULES = """
【洗稿规范参考：Futurism 洗稿技能 ~/.hermes/skills/futurism-fetcher】
技能已通过 Pi 的 --skill 机制加载，可读取技能目录里的参考文章。这是素材重写为中文内容时的固定风格，必须遵守：
1. 不是直译，用中文新闻语言重新表达原文信息；
2. 目标篇幅约 500-800 字；
3. 开头用一句话摘要概括核心内容，放在引用框（>）里；
4. 正文分段短小，每段 1-3 句，段与段之间空一行；
5. 按素材篇幅拆 2-3 个小标题，用自然语言或设问句（如“为什么非要让机器人爬山？”），不用“一、二、三”编号；
6. 列表用 `-` 无序列表，每项后空行；
7. 结尾用有画面感的收尾，展望未来或引发思考；
8. 文末不加互动引导，不加 #标签；
9. 全文不保留原文链接或出处标注；
10. 素材提供图片时，在正文对应位置用 `![图片描述](原图URL)` 原样引用；素材没有图片时不要编造图片地址。"""

REWRITE_SYSTEM = (
    "你是内容流水线中的「洗稿编辑」。"
    "素材已经直接提供给你，不需要抓取 RSS、不需要访问网络、不需要写任何文件。"
    "请按 Futurism 洗稿技能的洗稿规范，把素材完整改写成一篇中文文章。"
    "直接输出全文 Markdown，第一行是 `# 中文标题`，之后按规范组织正文；"
    "不要输出任务说明，不要输出 Obsidian 笔记或任何技能步骤解释。"
    + REWRITE_STYLE_RULES
)


def expert_node(state: dict) -> dict:
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
    config = state.get("config") or {}
    if config.get("rewrite_provider") == "pi":
        content = call_pi(REWRITE_SYSTEM, user, config)
    else:
        content = call_model(REWRITE_SYSTEM, user, config)
    content = content.strip()
    return {
        "drafts": [
            {
                "task_id": "rewrite_1",
                "role": "洗稿编辑",
                "section": "全文",
                "content": content,
            }
        ],
        "combined": content + "\n",
    }


def assembler_node(state: dict) -> dict:
    plan = state.get("plan") or {}
    tasks = plan.get("expert_tasks") or []
    drafts = {draft["task_id"]: draft for draft in state.get("drafts", [])}
    parts = [f"# {plan.get('title', '未命名内容')}\n"]
    parts.append(
        f"> 读者：{plan.get('audience', '目标读者')} ｜ 目标：{state.get('request', {}).get('goal', '')}"
    )
    for task in tasks:
        draft = drafts.get(task.get("id"))
        if not draft:
            continue
        parts.append(draft["content"])
    return {"combined": "\n\n".join(parts).strip() + "\n"}
