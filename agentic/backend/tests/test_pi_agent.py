import json
import subprocess

import pytest

from app import pi_agent


def events_with_text(text: str) -> str:
    events = [
        {"type": "session", "version": 3, "id": "s1", "timestamp": "t", "cwd": "/tmp"},
        {"type": "agent_start"},
        {"type": "turn_start"},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
            },
        },
        {"type": "turn_end", "message": {}, "toolResults": []},
        {"type": "agent_end", "messages": []},
    ]
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events)


@pytest.fixture
def fake_pi_binary(monkeypatch):
    monkeypatch.setattr(pi_agent, "resolve_pi_binary", lambda: "/fake/bin/pi")


def test_call_pi_builds_command_and_parses_message_end(
    monkeypatch, fake_pi_binary, tmp_path
):
    captured = {}
    skill_dir = tmp_path / "skills" / "futurism-fetcher"
    skill_dir.mkdir(parents=True)

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["input"] = kwargs.get("input")
        captured["env"] = kwargs.get("env")
        captured["timeout"] = kwargs.get("timeout")
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=events_with_text("## 正文\n洗稿内容。"),
            stderr="",
        )

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    result = pi_agent.call_pi(
        "你是洗稿编辑",
        '{"任务":"洗稿"}',
        {
            "pi_provider": "opencode-go",
            "pi_tools": "read,grep,find,ls",
            "model": "deepseek-v4-flash",
            "api_key": "sk-test",
            "pi_skill": str(skill_dir),
        },
    )

    assert result == "## 正文\n洗稿内容。"
    command = captured["command"]
    assert command[0] == "/fake/bin/pi"
    assert command[1:5] == ["--mode", "json", "--no-session", "--no-context-files"]
    assert command[command.index("--provider") + 1] == "opencode-go"
    assert command[command.index("--model") + 1] == "deepseek-v4-flash"
    assert command[command.index("--tools") + 1] == "read,grep,find,ls"
    assert command[command.index("--skill") + 1] == str(skill_dir)
    assert "--system-prompt" in command
    assert captured["input"] == '{"任务":"洗稿"}'
    assert captured["timeout"] == pi_agent.PI_TIMEOUT_SECONDS
    assert captured["env"]["OPENCODE_API_KEY"] == "sk-test"
    assert captured["env"]["PI_OFFLINE"] == "1"
    assert captured["env"]["PI_SKIP_VERSION_CHECK"] == "1"


def test_call_pi_raises_when_skill_path_missing(monkeypatch, fake_pi_binary):
    with pytest.raises(FileNotFoundError, match="Pi skill 路径不存在"):
        pi_agent.call_pi(
            "sys",
            "user",
            {
                "pi_provider": "opencode-go",
                "pi_tools": "",
                "model": "m",
                "api_key": "",
                "pi_skill": "~/missing-skill-dir",
            },
        )


def test_call_pi_omits_tools_and_api_key_when_blank(monkeypatch, fake_pi_binary):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        return subprocess.CompletedProcess(command, 0, stdout=events_with_text("ok"), stderr="")

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    pi_agent.call_pi(
        "sys",
        "user",
        {"pi_provider": "opencode-go", "pi_tools": "", "model": "m", "api_key": ""},
    )

    assert "--tools" not in captured["command"]
    assert "--api-key" not in captured["command"]


def test_call_pi_falls_back_to_api_key_flag(monkeypatch, fake_pi_binary):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        return subprocess.CompletedProcess(command, 0, stdout=events_with_text("ok"), stderr="")

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    pi_agent.call_pi(
        "sys",
        "user",
        {"pi_provider": "custom", "pi_tools": "", "model": "m", "api_key": "sk-xyz"},
    )

    assert captured["command"][captured["command"].index("--api-key") + 1] == "sk-xyz"


def test_call_pi_raises_on_nonzero_exit(monkeypatch, fake_pi_binary):
    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="provider boom")

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="provider boom"):
        pi_agent.call_pi(
            "sys",
            "user",
            {"pi_provider": "opencode-go", "pi_tools": "", "model": "m", "api_key": ""},
        )


def test_call_pi_raises_on_timeout(monkeypatch, fake_pi_binary):
    def fake_run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="超时"):
        pi_agent.call_pi(
            "sys",
            "user",
            {"pi_provider": "opencode-go", "pi_tools": "", "model": "m", "api_key": ""},
        )


def test_call_pi_raises_with_install_hint(monkeypatch):
    def missing():
        raise FileNotFoundError(f"未找到 pi 命令，请先安装：{pi_agent.INSTALL_HINT}")

    monkeypatch.setattr(pi_agent, "resolve_pi_binary", missing)
    with pytest.raises(FileNotFoundError, match="npm install -g"):
        pi_agent.call_pi(
            "sys",
            "user",
            {"pi_provider": "opencode-go", "pi_tools": "", "model": "m", "api_key": ""},
        )


def test_call_pi_raises_when_no_final_text(monkeypatch, fake_pi_binary):
    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout='{"type":"agent_start"}\n', stderr="")

    monkeypatch.setattr(pi_agent.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="没有返回最终文本"):
        pi_agent.call_pi(
            "sys",
            "user",
            {"pi_provider": "opencode-go", "pi_tools": "", "model": "m", "api_key": ""},
        )


def test_extract_final_text_joins_text_blocks():
    stdout = json.dumps(
        {
            "type": "message_end",
            "message": {
                "content": [
                    {"type": "text", "text": "第一段"},
                    {"type": "text", "text": "第二段"},
                ]
            },
        }
    )
    assert pi_agent._extract_final_text(stdout) == "第一段\n第二段"
