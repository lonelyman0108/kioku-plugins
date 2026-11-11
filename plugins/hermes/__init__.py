"""Kioku 的 Hermes 记忆 provider：把 Hermes 的回调接到 kioku_bridge。

服务地址与访问密钥来自 ``hermes memory setup``（或 ``kioku setup hermes``）写进这个 profile 的 ``.env``
的 KIOKU_SERVER_URL 与 KIOKU_API_KEY。
"""

from __future__ import annotations

import os
from typing import Any

from agent.memory_provider import MemoryProvider

from .kioku_bridge import KiokuClient, KiokuSession, is_trivial, key_problem, server_url_problem

# 这两样是新版本的 Hermes 才有的，发布版里没有：有就用，没有时退回自己的判断与普通的线程
try:
    from agent.memory_provider import is_trivial_prompt
except ImportError:
    is_trivial_prompt = is_trivial
try:
    from agent.memory_provider import spawn_context_thread
except ImportError:
    spawn_context_thread = None


_SETUP_HINT = "运行 hermes memory setup 选 kioku 并填好服务地址与访问密钥"


def _secret(name: str) -> str:
    """读这个 profile 的密钥；老版本的 Hermes 没有 secret_scope 时读环境变量。"""
    try:
        from agent.secret_scope import get_secret
    except ImportError:
        return (os.environ.get(name) or "").strip()
    return (get_secret(name, "") or "").strip()


class KiokuMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        # 每个 agent 一个实例，状态都在实例上，不放在模块里
        self._session = KiokuSession(
            lambda: KiokuClient(_secret("KIOKU_SERVER_URL"), _secret("KIOKU_API_KEY")),
            # 后台线程要带着调用方的上下文（多 profile 时靠它分清是哪个 profile）
            spawn=(lambda target, name: spawn_context_thread(target, name=name))
            if spawn_context_thread
            else None,
        )

    @property
    def name(self) -> str:
        return "kioku"

    # 只看配置，不发请求
    def is_available(self) -> bool:
        return not self.unavailable_reason()

    def unavailable_reason(self) -> str:
        problem = server_url_problem(_secret("KIOKU_SERVER_URL")) or key_problem(
            _secret("KIOKU_API_KEY")
        )
        return f"{problem}：{_SETUP_HINT}" if problem else ""

    def get_config_schema(self) -> list[dict[str, Any]]:
        # 两项都放在 .env 里（都带 env_var），所以不用 save_config
        return [
            {
                "key": "server_url",
                "description": "Kioku 的服务地址，例如 https://kioku.example.com（不带 /v1）",
                "required": True,
                "env_var": "KIOKU_SERVER_URL",
            },
            {
                "key": "api_key",
                "description": "访问密钥：在 Kioku 管理界面为运行时是 hermes 的应用签发",
                "secret": True,
                "required": True,
                "env_var": "KIOKU_API_KEY",
            },
        ]

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session.start(session_id, **kwargs)

    def system_prompt_block(self) -> str:
        return self._session.boot()

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        # 「好」「继续」这类没有内容的输入不召回
        if is_trivial_prompt(query):
            return ""
        return self._session.recall(query)

    def sync_turn(self, user_content: str, assistant_content: str, **kwargs: Any) -> None:
        self._session.turn_end(user_content, assistant_content)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return self._session.tools()

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        return self._session.call_tool(tool_name, args)

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        self._session.switch(new_session_id)

    def shutdown(self) -> None:
        self._session.flush()


def register(ctx) -> None:
    ctx.register_memory_provider(KiokuMemoryProvider())
