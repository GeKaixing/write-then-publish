import json
import os
import shutil
import subprocess
from pathlib import Path


PI_TIMEOUT_SECONDS = 600
INSTALL_HINT = "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"

_PI_BIN_CANDIDATES = [
    "pi",
    str(Path.home() / ".npm-global" / "bin" / "pi"),
    str(Path.home() / ".local" / "bin" / "pi"),
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
]

_API_KEY_ENV = {
    "opencode": "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "google": "GEMINI_API_KEY",
}


def resolve_pi_binary() -> str:
    found = shutil.which("pi")
    if found:
        return found
    for candidate in _PI_BIN_CANDIDATES:
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise FileNotFoundError(f"未找到 pi 命令，请先安装：{INSTALL_HINT}")


def _build_command(system: str, config: dict) -> tuple[list[str], dict]:
    provider = (config.get("pi_provider") or "opencode-go").strip()
    model = (config.get("model") or "").strip()
    if not model:
        raise ValueError("Pi Agent 需要填写模型名称")
    binary = resolve_pi_binary()
    command = [
        binary,
        "--mode",
        "json",
        "--no-session",
        "--no-context-files",
        "--provider",
        provider,
        "--model",
        model,
    ]
    skill = (config.get("pi_skill") or "").strip()
    if skill:
        skill_path = Path(skill).expanduser()
        if not skill_path.exists():
            raise FileNotFoundError(f"Pi skill 路径不存在：{skill_path}")
        command += ["--skill", str(skill_path)]
    tools = (config.get("pi_tools") or "").strip()
    if tools:
        command += ["--tools", tools]
    command += ["--system-prompt", system]

    env = dict(os.environ)
    env["PI_OFFLINE"] = "1"
    env["PI_SKIP_VERSION_CHECK"] = "1"
    api_key = (config.get("api_key") or "").strip()
    key_env = _API_KEY_ENV.get(provider)
    if api_key and key_env:
        env[key_env] = api_key
    elif api_key:
        command += ["--api-key", api_key]
    return command, env


def _extract_final_text(stdout: str) -> str:
    final_text = ""
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "message_end":
            continue
        message = event.get("message") or {}
        content = message.get("content") or []
        if isinstance(content, str):
            final_text = content
            continue
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        if parts:
            final_text = "\n".join(parts)
    return final_text.strip()


def call_pi(system: str, user: str, config: dict) -> str:
    command, env = _build_command(system, config)
    try:
        completed = subprocess.run(
            command,
            input=user,
            text=True,
            capture_output=True,
            timeout=PI_TIMEOUT_SECONDS,
            env=env,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"未找到 pi 命令，请先安装：{INSTALL_HINT}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Pi agent 调用超时（{PI_TIMEOUT_SECONDS}s）") from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-500:]
        raise RuntimeError(f"Pi agent 调用失败（exit {completed.returncode}）：{detail}")

    content = _extract_final_text(completed.stdout)
    if not content:
        detail = (completed.stderr or completed.stdout or "").strip()[-300:]
        raise RuntimeError(f"Pi agent 没有返回最终文本：{detail}")
    return content
