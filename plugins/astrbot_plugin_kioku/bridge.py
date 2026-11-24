"""Kioku 与 AstrBot 之间的转接：从 AstrBot 的事件里取出平台、群与发言人，调 Kioku 的生命周期接口。

插件里没有记忆逻辑，也没有提示词：注入什么、怎么抽取，都由服务端决定。
Kioku 不可用、超时或拒绝请求时只记日志、返回空，不打断对话。
/bind 绑定账号时把结果回复给发命令的人，Kioku 给的错误说明原样转达。
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from .kioku_client import AuthenticatedClient
from .kioku_client.api.binding import post_v1_bind, post_v1_bind_code, post_v1_bind_void
from .kioku_client.api.lifecycle import post_v1_lifecycle_event
from .kioku_client.models import (
    BindCode,
    BindCodeRequest,
    BindRequest,
    BindResult,
    BindResultStatus,
    BindTarget,
    ChatType,
    ErrorResponse,
    LifecycleResponse,
    PlatformRef,
    PromptSubmitEvent,
    PromptSubmitEventEvent,
    SessionContext,
    SessionStartEvent,
    SessionStartEventEvent,
    TurnEndEvent,
    TurnEndEventEvent,
    VoidBindCodeRequest,
)

logger = logging.getLogger("astrbot_plugin_kioku")

# 服务端的平台标识只收小写字母、数字和 _.-，开头是字母或数字，最长 32 个字
NOT_PLATFORM = re.compile(r"[^a-z0-9_.-]")
_KEY_ASCII = re.compile(r"^[!-~]+$")
# 服务端的长度上限：消息与标识（sessionId / sender.id / group.id），按 UTF-16 码元数
MAX_TEXT = 20_000
MAX_ID = 200
MAX_SESSION_ID = 200
# 服务端允许名字最长 4000 个字符，这里截断保留前 128 个字符
MAX_NAME = 128
# 会话开始的启动加载（独立人格与长期规范）很少变，按会话缓存这么久，不必每轮都请求
BOOT_TTL_SECONDS = 600
# 启动加载未获取到（Kioku 不可用或没有内容）时，过这么久再试
BOOT_RETRY_SECONDS = 60
# 服务端收的绑定码最长这么多个字，太长的整个请求会被拒
MAX_CODE = 64
# 确认合并：跟在绑定码后面，例如「/bind ABCD2345 确认」
CONFIRM_WORDS = ("确认", "confirm")

# /bind 的回复：直接发给发命令的人，要短
GROUP_HINT = "绑定账号请私聊我发 /bind。"
CONFIRM_NEEDS_CODE = "确认要带上码：/bind <码> 确认"
GROUP_VOIDED = "这个码已经在群里公开，作废了，请在私聊里重新申请。"
GROUP_PUBLIC = "这个码已经在群里公开了，请在私聊里发 /bind 重新申请，旧码会作废。"
NOT_CONFIGURED = "尚未接入 Kioku，无法绑定。"
UNAVAILABLE = "Kioku 暂时不可用，请稍后再试。"
BOUND = "绑定好了。"
WAITING = "已提交，等对方在管理界面确认。"


@dataclass(frozen=True)
class Turn:
    """一轮对话里转接要用的东西，由插件从 AstrBot 的事件里取出。"""

    platform: str
    session_id: str
    group_id: str | None
    sender_id: str
    sender_name: str | None
    text: str


def clip(text: str, limit: int) -> str:
    """按 UTF-16 码元截断：服务端按 JS 字符串的长度数，表情符号这类字占两个。不切开代理对。"""
    units = text.encode("utf-16-le", "surrogatepass")
    if len(units) <= limit * 2:
        return text
    return units[: limit * 2].decode("utf-16-le", "ignore")


def server_url_problem(url: str) -> str | None:
    if not url:
        return "尚未配置 Kioku 服务地址"
    if re.search(r"[\s\x00-\x1f\x7f]", url):
        return "服务地址里不能有空白或控制字符"
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return "服务地址要以 http:// 或 https:// 开头"
    if parts.username or parts.password or parts.query or parts.fragment:
        return "服务地址里不要带账号密码、查询参数"
    return None


def key_problem(key: str) -> str | None:
    if not key:
        return "尚未配置 Kioku 访问密钥"
    if not _KEY_ASCII.fullmatch(key):
        return "访问密钥格式不正确：只能包含可见 ASCII 字符，不能有空白"
    return None


def _error_code(parsed: Any, content: bytes) -> str | None:
    if isinstance(parsed, ErrorResponse):
        code = parsed.additional_properties.get("code")
        if isinstance(code, str) and code:
            return code
    try:
        payload = json.loads(content.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    return code if isinstance(code, str) and code else None


def platform_of(name: str) -> str:
    platform = NOT_PLATFORM.sub("_", name.strip().lower())[:32]
    return platform if platform[:1].isalnum() else f"p{platform}"[:32]


def session_context(turn: Turn) -> SessionContext:
    """会话上下文：平台账号原样上报，由服务端解析成联系人、判断是不是本人。"""
    sender_id = clip((turn.sender_id or "").strip(), MAX_ID)
    sender = (
        PlatformRef(id=sender_id, name=turn.sender_name[:MAX_NAME])
        if turn.sender_name
        else PlatformRef(id=sender_id)
    )
    platform = platform_of(turn.platform)
    group_id = clip((turn.group_id or "").strip(), MAX_ID)
    if group_id:
        return SessionContext(
            chat_type=ChatType.GROUP,
            platform=platform,
            group=PlatformRef(id=group_id),
            sender=sender,
        )
    return SessionContext(chat_type=ChatType.DIRECT, platform=platform, sender=sender)


def command_args(message: str, command: str = "bind") -> str:
    """命令后面的整段文字。AstrBot 交来的消息可能还带着唤醒前缀（例如 /），
    Telegram 的命令常带着机器人名（/bind@MyBot），都去掉。"""
    text = message.strip()
    match = re.match(rf"\W*{command}(?:@\S*)?(?:\s+|$)", text, re.IGNORECASE)
    return text[match.end() :] if match else ""


def parse_code(args: str) -> tuple[str, bool]:
    """绑定码，以及是不是确认合并（开头或末尾带确认词）。码里的空白去掉，大小写与连字符交给服务端认。"""
    text = args.strip()
    for word in CONFIRM_WORDS:
        if text.lower().endswith(word):
            return re.sub(r"\s+", "", text[: -len(word)]), True
        if text.lower().startswith(word):
            return re.sub(r"\s+", "", text[len(word) :]), True
    return re.sub(r"\s+", "", text), False


def preview_text(result: BindResult, code: str) -> str:
    """预览：要并到谁那里、并了之后会怎样，以及怎么确认。"""
    target = result.target
    if isinstance(target, BindTarget):
        name = target.display_name if isinstance(target.display_name, str) else ""
        who = (
            f"{target.platform} 上的「{name}」（{target.account_hint}）"
            if name
            else f"{target.platform} 上的账号 {target.account_hint}"
        )
    else:
        who = "另一个账号"
    lines = [f"要把这个账号绑到 {who}。绑定后两边私聊的记忆将互通，操作不可撤销。"]
    if result.needs_approval:
        lines.append("确认之后还要对方在管理界面同意。")
    lines.append(f"确认请发：/bind {code} 确认")
    return "\n".join(lines)


class KiokuBridge:
    def __init__(
        self,
        base_url: str,
        key: str,
        timeout: float = 4.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        clean_url = (base_url or "").strip().rstrip("/")
        clean_key = (key or "").strip()
        self._base_url = clean_url
        problem = (
            (server_url_problem(clean_url) or key_problem(clean_key))
            if (clean_url or clean_key)
            else "未配置"
        )
        if clean_url and clean_key and problem:
            logger.warning("Kioku 配置无效：%s", problem)
        httpx_args: dict[str, Any] = {"trust_env": False}
        if transport:
            httpx_args["transport"] = transport
        self._client = (
            AuthenticatedClient(
                base_url=clean_url,
                token=clean_key,
                timeout=httpx.Timeout(timeout),
                follow_redirects=False,
                httpx_args=httpx_args,
            )
            if clean_url and clean_key and not problem
            else None
        )
        # 会话标识 → （到期时间，启动加载）
        self._boot: dict[str, tuple[float, str | None]] = {}
        self._warned_mode = False

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def boot(self, turn: Turn) -> str | None:
        """会话开始时注入的独立人格与长期规范，按会话缓存；未获取到的也记下，过一会儿再试。"""
        if not (turn.sender_id or "").strip():
            return None
        now = time.monotonic()
        cached = self._boot.get(turn.session_id)
        if cached and now < cached[0]:
            return cached[1]
        context = await self._send(
            SessionStartEvent(
                event=SessionStartEventEvent.SESSION_START,
                session_id=clip(turn.session_id, MAX_SESSION_ID),
                context=session_context(turn),
            )
        )
        # 顺手清掉过期的，缓存不会越攒越多
        self._boot = {sid: entry for sid, entry in self._boot.items() if now < entry[0]}
        ttl = BOOT_TTL_SECONDS if context is not None else BOOT_RETRY_SECONDS
        self._boot[turn.session_id] = (now + ttl, context)
        return context

    async def recall(self, turn: Turn) -> str | None:
        """这一轮相关的记忆与关于对方的事实。"""
        if not turn.text.strip() or not (turn.sender_id or "").strip():
            return None
        return await self._send(
            PromptSubmitEvent(
                event=PromptSubmitEventEvent.PROMPT_SUBMIT,
                prompt=clip(turn.text, MAX_TEXT),
                session_id=clip(turn.session_id, MAX_SESSION_ID),
                context=session_context(turn),
            )
        )

    async def turn_end(self, turn: Turn, reply: str) -> None:
        """把这一轮交给 Kioku 缓冲，攒批之后抽取成记忆。"""
        if (
            not turn.text.strip()
            or not (turn.session_id or "").strip()
            or not (turn.sender_id or "").strip()
        ):
            return
        await self._send(
            TurnEndEvent(
                event=TurnEndEventEvent.TURN_END,
                session_id=clip(turn.session_id, MAX_SESSION_ID),
                context=session_context(turn),
                user=clip(turn.text, MAX_TEXT),
                reply=clip(reply, MAX_TEXT),
            )
        )

    async def bind(self, turn: Turn, args: str) -> str:
        """/bind 后面的整段文字。私聊里：空的申请绑定码；带码的先预览要并到谁那里，再带上「确认」才合并。
        群里不发码也不收码：带码的把这个码作废（它已经公开了），不带的提示去私聊。"""
        code, confirm = parse_code(args)
        if turn.group_id and not code:
            return GROUP_HINT
        # 只有确认词、没带码：不能当成申请新码（那样会把手上的码作废）
        if confirm and not code:
            return CONFIRM_NEEDS_CODE
        if self._client is None:
            return NOT_CONFIGURED
        if not (turn.sender_id or "").strip():
            return UNAVAILABLE
        context = session_context(turn)
        try:
            if turn.group_id:
                response = await post_v1_bind_void.asyncio_detailed(
                    client=self._client,
                    body=VoidBindCodeRequest(code=code[:MAX_CODE], context=context),
                )
            elif code:
                response = await post_v1_bind.asyncio_detailed(
                    client=self._client,
                    body=BindRequest(code=code[:MAX_CODE], context=context, confirm=confirm),
                )
            else:
                response = await post_v1_bind_code.asyncio_detailed(
                    client=self._client, body=BindCodeRequest(context=context)
                )
        except Exception as err:  # noqa: BLE001  Kioku 出什么错都只回一句，不让命令报错
            logger.warning("请求 Kioku 失败：%s", type(err).__name__)
            return GROUP_PUBLIC if turn.group_id else UNAVAILABLE
        if turn.group_id:
            if response.status_code == 204:
                return GROUP_VOIDED
            logger.warning("Kioku 没有作废群里的绑定码：HTTP %s", int(response.status_code))
            return GROUP_PUBLIC
        result = response.parsed
        if isinstance(result, BindCode):
            minutes = max(1, round(result.expires_in_seconds / 60))
            return (
                f"绑定码：{result.code}\n"
                f"{minutes} 分钟内到另一个平台私聊我，发「/bind {result.code}」。"
            )
        if isinstance(result, BindResult):
            if result.status == BindResultStatus.PREVIEW:
                return preview_text(result, code[:MAX_CODE].upper())
            return BOUND if result.status == BindResultStatus.MERGED else WAITING
        # 访问密钥无效是机器人所有者的配置问题，不把说明转给发命令的人
        status = int(response.status_code)
        err_code = _error_code(result, response.content)
        if isinstance(result, ErrorResponse) and status != 401:
            return result.error
        self._log_rejected_response("绑定请求", status, err_code)
        return UNAVAILABLE

    def _log_rejected_response(self, label: str, status: int, code: str | None) -> None:
        if 300 <= status < 400:
            logger.warning(
                "Kioku 返回了跳转（HTTP %s），不跟踪跳转：请将配置中的 kioku_url 更新为目标地址",
                status,
            )
        elif status == 401 and code == "legacy_key":
            logger.warning(
                "访问密钥为升级前签发，已失效：请在 Kioku 管理界面「客户端」页为 astrbot 客户端重新签发访问密钥并更新配置 kioku_key"
            )
        elif status == 503 and code == "legacy_database":
            logger.warning(
                "Kioku 服务端已升级、尚未迁移旧数据：请管理员访问 %s/legacy-upgrade 完成迁移",
                self._base_url,
            )
        elif status == 503 and code == "database_unavailable":
            logger.warning("Kioku 服务端数据库暂时不可用（HTTP 503 database_unavailable）")
        else:
            logger.warning("Kioku 没有接受%s：HTTP %s", label, status)

    async def aclose(self) -> None:
        """关掉到 Kioku 的连接池，插件停用或重载时调用。"""
        if self._client is not None:
            await self._client.get_async_httpx_client().aclose()

    async def _send(self, body: SessionStartEvent | PromptSubmitEvent | TurnEndEvent) -> str | None:
        if self._client is None:
            return None
        try:
            response = await post_v1_lifecycle_event.asyncio_detailed(
                client=self._client, body=body
            )
        except Exception as err:  # noqa: BLE001  Kioku 出什么错都不能打断对话
            logger.warning("请求 Kioku 失败：%s", type(err).__name__)
            return None
        status = int(response.status_code)
        result = response.parsed
        if status != 200:
            self._log_rejected_response("请求", status, _error_code(result, response.content))
            return None
        if not isinstance(result, LifecycleResponse):
            logger.warning("Kioku 响应格式不正确：HTTP %s", status)
            return None
        mode = str(getattr(result.host_output, "mode", ""))
        value = result.host_output.value
        context = value.get("context") if isinstance(value, dict) else None
        if context is None and mode not in ("none", "return_value") and not self._warned_mode:
            self._warned_mode = True
            logger.warning(
                "Kioku 返回了非 astrbot 格式的输出（%s）：请检查 Kioku 客户端运行时类型是否为 astrbot",
                mode,
            )
        return context if isinstance(context, str) and context.strip() else None
