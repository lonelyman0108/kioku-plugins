"""Kioku 的客户端与会话状态，不依赖 Hermes：只用标准库，可以单独测试。

Hermes 这一边的 provider（``__init__.py``）只是把它的回调接到这里。这里不放提示词和格式逻辑，都由 Kioku 的服务端决定。
任何失败都不抛到 Hermes 里：记忆服务出问题不能打断对话。报错的文字不带访问密钥，只写类别。
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import subprocess
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger("kioku")

# 各事件等待服务端的上限（秒）。召回在用户发出消息之后等着，给得紧
TIMEOUTS = {"session.start": 6.0, "prompt.submit": 4.0, "turn.end": 5.0}
TOOLS_TIMEOUT = 4.0
TOOL_CALL_TIMEOUT = 20.0
# 与服务端 contracts 的上限一致
MAX_PROMPT = 20_000
MAX_REPLY = 20_000
MAX_SESSION_ID = 200
MAX_NAME = 128
# 访问密钥只能是可见的 ASCII 字符：别的字符放不进请求头
_KEY = re.compile(r"^[\x21-\x7e]+$")
# 响应最多读这么多字节：服务端出了问题时不把内存读满
_MAX_RESPONSE = 4 * 1024 * 1024


class KiokuFailure(Exception):
    """文字由这里自己写、不含访问密钥的失败，可以原样记进日志。"""


def clip(text: str, limit: int) -> str:
    """按码点截断（Python 的字符串本来就按码点算，不会切开一个字）。"""
    return text if len(text) <= limit else text[:limit]


def server_url_problem(url: str) -> str | None:
    """服务地址的问题；没有问题时为 None。"""
    if not url:
        return "没有配置 Kioku 的服务地址"
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
        return "没有配置 Kioku 的访问密钥"
    if not _KEY.match(key):
        return "访问密钥的格式不对：只能是可见的 ASCII 字符，不能有空白"
    return None


# 没有内容的输入：问候、应答这类，不值得召回一次
_TRIVIAL = re.compile(
    r"^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|hi|hey|hello|continue|go ahead|"
    r"got it|done|next|好|好的|嗯|是|不|对|行|可以|继续|谢谢|你好|收到)[\s!?.,。！？，~]*$",
    re.IGNORECASE,
)


def is_trivial(text: str | None) -> bool:
    """空的输入、斜杠命令与单纯的问候应答。"""
    stripped = (text or "").strip()
    return not stripped or stripped.startswith("/") or bool(_TRIVIAL.match(stripped))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟着跳转走：访问密钥只发给配置的地址。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _failure_kind(exc: BaseException) -> str:
    """错误的类别：只取类名，不取文字（文字里可能带着请求头）。"""
    if isinstance(exc, TimeoutError) or "timed out" in str(getattr(exc, "reason", "")):
        return "超时"
    return type(exc).__name__


class KiokuClient:
    """向 Kioku 发请求。每次调用都可能抛 KiokuFailure。"""

    def __init__(self, url: str, key: str, opener: urllib.request.OpenerDirector | None = None):
        problem = server_url_problem(url) or key_problem(key)
        if problem:
            raise KiokuFailure(problem)
        self.url = url.rstrip("/")
        self._key = key
        # 不读环境里的代理设置之外的东西；跳转一律不跟
        self._opener = opener or urllib.request.build_opener(_NoRedirect)

    def _post(
        self, path: str, body: dict[str, Any], timeout: float, accept: str
    ) -> tuple[str, str]:
        request = urllib.request.Request(
            f"{self.url}{path}",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "accept": accept,
                "authorization": f"Bearer {self._key}",
            },
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                raw = response.read(_MAX_RESPONSE + 1)
                if len(raw) > _MAX_RESPONSE:
                    raise KiokuFailure("Kioku 的响应太大")
                return raw.decode("utf-8", "replace"), response.headers.get("content-type", "")
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise KiokuFailure(
                    f"Kioku 返回了跳转（{exc.code}），把地址改成跳转之后的地址"
                ) from None
            raise KiokuFailure(f"Kioku 返回 HTTP {exc.code}") from None
        except KiokuFailure:
            raise
        # 连不上、超时、TLS、对方断开这类（URLError、TimeoutError、SSLError 都是 OSError）
        except (OSError, http.client.HTTPException) as exc:
            raise KiokuFailure(f"无法连接 Kioku（{_failure_kind(exc)}）") from None

    def event(self, event: str, body: dict[str, Any]) -> str:
        """交一个生命周期事件，返回服务端要注入的文本（没有时为空字符串）。"""
        text, _ = self._post(
            "/v1/lifecycle/event", {"event": event, **body}, TIMEOUTS[event], "application/json"
        )
        if event == "turn.end":
            return ""
        try:
            output = json.loads(text).get("hostOutput") or {}
        except (ValueError, AttributeError):
            raise KiokuFailure("Kioku 的响应格式不对") from None
        return context_of(output)

    def rpc(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        """对 Kioku 的 MCP 端点发一个 JSON-RPC 请求，返回 result。"""
        text, content_type = self._post(
            "/v1/mcp",
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            timeout,
            "application/json, text/event-stream",
        )
        # 回答可能是一段事件流：取最后一条 data
        if "text/event-stream" in content_type:
            data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
            text = data[-1] if data else ""
        try:
            message = json.loads(text)
        except ValueError:
            raise KiokuFailure("Kioku 的响应格式不对") from None
        if not isinstance(message, dict) or not isinstance(message.get("result"), dict):
            raise KiokuFailure("Kioku 的工具接口返回了错误")
        return message["result"]


def context_of(output: dict[str, Any]) -> str:
    """服务端要注入的上下文文本。只取文本，输出里的其他字段一律不用。"""
    mode = output.get("mode")
    value = output.get("value")
    text: Any = None
    if mode == "return_value" and isinstance(value, dict):
        text = value.get("context")
    elif mode == "stdout_text":
        text = value
    elif mode == "stdout_json" and isinstance(value, dict):
        text = (value.get("hookSpecificOutput") or {}).get("additionalContext")
    return text if isinstance(text, str) else ""


def project_of(cwd: str | None) -> dict[str, str]:
    """当前项目的目录名与 git 仓库名，服务端用它们召回与项目相关的记忆；取不到的就不带。"""
    if not cwd:
        return {}
    project: dict[str, str] = {}
    name = os.path.basename(os.path.normpath(cwd))
    if name:
        project["dirName"] = name[:MAX_NAME]
    try:
        remote = subprocess.run(
            ["git", "-C", cwd, "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        ).stdout.strip()
        match = re.search(r"([^/:]+?)(?:\.git)?$", remote)
        if match and match.group(1):
            project["repoName"] = match.group(1)[:MAX_NAME]
    except (OSError, subprocess.SubprocessError):
        # 没有 git、超时：只带目录名
        return project
    return project


def tool_schemas(result: dict[str, Any]) -> list[dict[str, Any]]:
    """MCP 的工具清单换成 Hermes 要的写法（OpenAI 的函数调用格式）。格式不对的项跳过。"""
    schemas = []
    for tool in result.get("tools") or []:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            continue
        parameters = tool.get("inputSchema")
        schemas.append(
            {
                "name": tool["name"],
                "description": tool.get("description")
                if isinstance(tool.get("description"), str)
                else "",
                "parameters": parameters
                if isinstance(parameters, dict)
                else {"type": "object", "properties": {}},
            }
        )
    return schemas


def tool_result(result: dict[str, Any]) -> str:
    """MCP 的工具结果换成 Hermes 要的 JSON 字符串。"""
    texts = [
        block.get("text", "")
        for block in result.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    text = "\n".join(text for text in texts if isinstance(text, str))
    return json.dumps(
        {"error": text} if result.get("isError") else {"result": text}, ensure_ascii=False
    )


class KiokuSession:
    """一个 Hermes 会话里和 Kioku 打交道的状态。

    只在本机的会话里生效（命令行、桌面、编辑器这类）：消息网关来的会话可能是群聊或别人的私聊，
    Kioku 的工具不带会话上下文，按访问密钥的全部权限读写，这些会话里一律不注入、不上报、不给工具。
    """

    def __init__(
        self,
        client_factory: Callable[[], KiokuClient],
        *,
        spawn: Callable[..., threading.Thread] | None = None,
    ):
        self._client_factory = client_factory
        self._client: KiokuClient | None = None
        self._spawn = spawn or (
            lambda target, name: threading.Thread(target=target, name=name, daemon=True)
        )
        self.session_id = ""
        self.active = False
        # 只有主会话才上报：子 agent、定时任务这类不写会话摘要
        self.primary = True
        self.inactive_reason = ""
        self._boot = ""
        self._tools: list[dict[str, Any]] = []
        self._pending: list[threading.Thread] = []
        self._started = False
        self._tools_loaded = False
        self._lock = threading.Lock()

    # -- 开始 ---------------------------------------------------------------

    def start(self, session_id: str, **kwargs: Any) -> None:
        self._started = True
        self.session_id = (session_id or "")[:MAX_SESSION_ID]
        self.primary = (kwargs.get("agent_context") or "primary") == "primary"
        if kwargs.get("gateway_session_key") or kwargs.get("chat_id"):
            self.inactive_reason = "消息网关的会话里不启用 Kioku"
            logger.info("Kioku：%s", self.inactive_reason)
            return
        try:
            self._client = self._client_factory()
        except KiokuFailure as exc:
            self.inactive_reason = str(exc)
            logger.warning("Kioku 未生效：%s", exc)
            return
        self.active = True
        cwd = kwargs.get("cwd")
        # 启动加载与工具清单（登记时没取到的话）一起取，各有时限：启动时最多等其中较长的一个
        jobs = [
            self._spawn(lambda: self._load_boot(cwd), "kioku-boot"),
            self._spawn(self._ensure_tools, "kioku-tools"),
        ]
        for job in jobs:
            job.start()
        for job in jobs:
            job.join(max(TIMEOUTS["session.start"], TOOLS_TIMEOUT) + 1.0)

    def _body(self) -> dict[str, Any]:
        return {"sessionId": self.session_id} if self.session_id else {}

    def _load_boot(self, cwd: str | None) -> None:
        try:
            body = self._body()
            project = project_of(cwd if isinstance(cwd, str) else None)
            if project:
                body["project"] = project
            self._boot = self._client.event("session.start", body)  # type: ignore[union-attr]
        except KiokuFailure as exc:
            logger.warning("Kioku session.start 未生效：%s", exc)

    # -- 每轮 ---------------------------------------------------------------

    def boot(self) -> str:
        return self._boot if self.active else ""

    def recall(self, query: str) -> str:
        prompt = (query or "").strip()
        if not self.active or not prompt:
            return ""
        try:
            return self._client.event(  # type: ignore[union-attr]
                "prompt.submit", {**self._body(), "prompt": clip(prompt, MAX_PROMPT)}
            )
        except KiokuFailure as exc:
            logger.warning("Kioku prompt.submit 未生效：%s", exc)
            return ""

    def turn_end(self, user: str, reply: str) -> None:
        """把这一轮交给服务端写会话摘要：放到后台，不拖住下一次输入。"""
        user = (user or "").strip()
        reply = (reply or "").strip()
        if not self.active or not self.primary or not self.session_id or not user or not reply:
            return
        body = {**self._body(), "user": clip(user, MAX_PROMPT), "reply": clip(reply, MAX_REPLY)}

        def send() -> None:
            try:
                self._client.event("turn.end", body)  # type: ignore[union-attr]
            except KiokuFailure as exc:
                logger.warning("Kioku turn.end 未生效：%s", exc)

        thread = self._spawn(send, "kioku-turn-end")
        with self._lock:
            self._pending = [t for t in self._pending if t.is_alive()]
            self._pending.append(thread)
        thread.start()

    # -- 工具 ---------------------------------------------------------------

    def tools(self) -> list[dict[str, Any]]:
        """这个会话能用的工具。

        Hermes 在 provider 初始化之前就按这份清单登记「哪个工具归谁」，那时还不知道是什么会话：
        还没开始时先把清单取来（只取一次），让登记得上；开始之后，不启用的会话里返回空的，模型就看不到这些工具
        （登记还在，调用时由 call_tool 拒绝）。
        """
        if not self._started:
            self._ensure_tools()
            return list(self._tools)
        return list(self._tools) if self.active else []

    def _ensure_tools(self) -> None:
        with self._lock:
            if self._tools_loaded:
                return
            self._tools_loaded = True
        try:
            client = self._client or self._client_factory()
            self._tools = tool_schemas(client.rpc("tools/list", {}, TOOLS_TIMEOUT))
        except KiokuFailure as exc:
            logger.warning("Kioku 的工具没有取到：%s", exc)

    def call_tool(self, name: str, args: dict[str, Any]) -> str:
        if not self.active or name not in {tool["name"] for tool in self._tools}:
            return json.dumps({"error": "这个会话里没有这个工具"}, ensure_ascii=False)
        try:
            result = self._client.rpc(  # type: ignore[union-attr]
                "tools/call", {"name": name, "arguments": args or {}}, TOOL_CALL_TIMEOUT
            )
        except KiokuFailure as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)
        return tool_result(result)

    # -- 结束 ---------------------------------------------------------------

    def switch(self, session_id: str) -> None:
        self.session_id = (session_id or "")[:MAX_SESSION_ID]

    def flush(self, timeout: float = TIMEOUTS["turn.end"] + 1.0) -> None:
        """等还没发完的上报：进程要退出时调，否则最后一轮就丢了。"""
        with self._lock:
            pending = list(self._pending)
        for thread in pending:
            thread.join(timeout)
