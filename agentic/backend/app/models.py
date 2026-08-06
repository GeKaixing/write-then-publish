from typing import Literal

from pydantic import BaseModel, Field


class RunRequest(BaseModel):
    source_material: str = Field(default="", description="用户粘贴的素材")
    rss_url: str = Field(default="", description="RSS/Atom 源地址，可为空")
    rss_limit: int = Field(default=8, ge=1, le=30)
    rss_items: list[dict] = Field(default_factory=list, description="预览后勾选的 RSS 条目")
    goal: str = Field(default="写一篇有信息增量、适合目标平台的图文", description="创作目标")
    platform: Literal["小红书", "X", "公众号", "通用"] = Field(default="小红书")
    tone: str = Field(default="专业", description="语气：专业/轻松/故事化/犀利")
    word_count: int = Field(default=1200, ge=100, le=10000)
    max_revisions: int = Field(default=2, ge=0, le=5)


class AgentConfig(BaseModel):
    provider: Literal["demo", "openai_compatible", "ollama"] = Field(default="demo")
    base_url: str = Field(default="", description="OpenAI 兼容接口地址；Ollama 默认本机")
    api_key: str = Field(default="", description="可为空，兼容本地服务")
    model: str = Field(default="gpt-4o-mini")
    temperature: float = Field(default=0.7, ge=0.0, le=1.5)
    rewrite_provider: Literal["llm", "pi"] = Field(
        default="llm", description="洗稿节点执行方式：llm 用主模型，pi 用 Pi agent"
    )
    pi_provider: str = Field(default="opencode-go", description="Pi 的 provider 名称")
    pi_tools: str = Field(
        default="read,grep,find,ls",
        description="Pi 允许的工具列表，逗号分隔；留空表示放行全部",
    )
    pi_skill: str = Field(
        default="~/.hermes/skills/futurism-fetcher",
        description="Pi 加载的技能目录或文件，留空不加载",
    )


class RunPayload(RunRequest):
    config: AgentConfig | None = None
