"""Hermes 的 agent.memory_provider 的替身：只有 provider 用到的几样。"""

import threading


class MemoryProvider:
    def unavailable_reason(self) -> str:
        return ""


def is_trivial_prompt(text) -> bool:
    stripped = (text or "").strip().lower()
    return not stripped or stripped.startswith("/") or stripped in {"ok", "yes", "thanks"}


def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):
    return threading.Thread(target=target, name=name, daemon=daemon, args=args, kwargs=kwargs)
