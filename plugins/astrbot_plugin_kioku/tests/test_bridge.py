"""转接逻辑：上报的会话上下文、发出的生命周期事件、启动加载的缓存，以及 Kioku 不可用时静默降级。"""

import asyncio
import json

import httpx
from astrbot_plugin_kioku.bridge import (
    BOOT_RETRY_SECONDS,
    BOOT_TTL_SECONDS,
    MAX_NAME,
    MAX_SESSION_ID,
    MAX_TEXT,
    KiokuBridge,
    Turn,
    clip,
    platform_of,
)

PRIVATE = Turn(
    platform="aiocqhttp",
    session_id="aiocqhttp:FriendMessage:1001",
    group_id=None,
    sender_id="1001",
    sender_name="小明",
    text="周五读什么",
)
GROUP = Turn(
    platform="aiocqhttp",
    session_id="aiocqhttp:GroupMessage:2001",
    group_id="2001",
    sender_id="1002",
    sender_name="群名片",
    text="周五读什么",
)


def bridge_with(handler) -> tuple[KiokuBridge, list[dict]]:
    sent: list[dict] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return handler(request)

    bridge = KiokuBridge(
        "https://kioku.example.com/", "kioku_test", transport=httpx.MockTransport(record)
    )
    return bridge, sent


def answer(context: str):
    return lambda _request: httpx.Response(
        200,
        json={
            "hostOutput": {"mode": "return_value", "value": {"context": context}},
            "shortIds": [],
        },
    )


def test_platform_names_follow_the_server_rule():
    assert platform_of("aiocqhttp") == "aiocqhttp"
    assert platform_of("QQ Official") == "qq_official"
    assert platform_of("_weird") == "p_weird"
    assert len(platform_of("x" * 50)) == 32


def test_private_and_group_contexts_are_reported_as_is():
    bridge, sent = bridge_with(answer("<recall>…</recall>"))
    assert asyncio.run(bridge.recall(PRIVATE)) == "<recall>…</recall>"
    assert asyncio.run(bridge.recall(GROUP)) == "<recall>…</recall>"
    assert sent[0] == {
        "event": "prompt.submit",
        "prompt": "周五读什么",
        "sessionId": "aiocqhttp:FriendMessage:1001",
        "context": {
            "chatType": "direct",
            "platform": "aiocqhttp",
            "sender": {"id": "1001", "name": "小明"},
        },
    }
    assert sent[1]["context"] == {
        "chatType": "group",
        "platform": "aiocqhttp",
        "group": {"id": "2001"},
        "sender": {"id": "1002", "name": "群名片"},
    }


def test_boot_is_cached_per_session(monkeypatch):
    bridge, sent = bridge_with(answer("独立人格与长期规范"))
    clock = [1000.0]
    monkeypatch.setattr("astrbot_plugin_kioku.bridge.time.monotonic", lambda: clock[0])
    assert asyncio.run(bridge.boot(GROUP)) == "独立人格与长期规范"
    assert asyncio.run(bridge.boot(GROUP)) == "独立人格与长期规范"
    assert asyncio.run(bridge.boot(PRIVATE)) == "独立人格与长期规范"
    assert [s["event"] for s in sent] == ["session.start", "session.start"]
    clock[0] += BOOT_TTL_SECONDS + 1
    asyncio.run(bridge.boot(GROUP))
    assert len(sent) == 3


def test_boot_failures_are_retried_after_a_while(monkeypatch):
    bridge, sent = bridge_with(lambda _r: httpx.Response(500, text="服务内部错误"))
    clock = [1000.0]
    monkeypatch.setattr("astrbot_plugin_kioku.bridge.time.monotonic", lambda: clock[0])
    assert asyncio.run(bridge.boot(GROUP)) is None
    assert asyncio.run(bridge.boot(GROUP)) is None
    assert len(sent) == 1
    clock[0] += BOOT_RETRY_SECONDS + 1
    asyncio.run(bridge.boot(GROUP))
    assert len(sent) == 2


def test_long_text_is_clipped_by_utf16_length():
    # 服务端按 JS 字符串的长度数：表情符号一个占两个码元，按字数截会超出上限
    bridge, sent = bridge_with(answer("<recall>…</recall>"))
    long_turn = Turn(
        **{
            **GROUP.__dict__,
            "session_id": "s" * 300,
            "sender_name": "名" * 5_000,
            "text": "😀" * 15_000,
        }
    )
    asyncio.run(bridge.recall(long_turn))
    assert sent[0]["prompt"] == "😀" * (MAX_TEXT // 2)
    assert sent[0]["sessionId"] == "s" * MAX_SESSION_ID
    # 名字服务端只记前 128 个字，长了整个请求会被拒
    assert sent[0]["context"]["sender"]["name"] == "名" * MAX_NAME
    # 截断处落在一个表情符号中间时整个丢掉，不留半个
    assert clip("a" + "😀" * 3, 4) == "a😀"
    assert clip("短", 4) == "短"


def test_turn_end_reports_the_reply_and_skips_empty_turns():
    bridge, sent = bridge_with(
        lambda _r: httpx.Response(
            200, json={"hostOutput": {"mode": "none", "value": None}, "shortIds": []}
        )
    )
    asyncio.run(bridge.turn_end(GROUP, "还没定"))
    asyncio.run(bridge.turn_end(Turn(**{**GROUP.__dict__, "text": "  "}), "嗯"))
    assert sent == [
        {
            "event": "turn.end",
            "sessionId": "aiocqhttp:GroupMessage:2001",
            "context": {
                "chatType": "group",
                "platform": "aiocqhttp",
                "group": {"id": "2001"},
                "sender": {"id": "1002", "name": "群名片"},
            },
            "user": "周五读什么",
            "reply": "还没定",
        }
    ]


def test_failures_degrade_silently():
    def down(_request):
        raise httpx.ConnectError("连不上")

    for handler in (
        down,
        lambda _r: httpx.Response(401, json={"error": "未登录或凭据无效"}),
        lambda _r: httpx.Response(500, text="服务内部错误"),
        answer("   "),
    ):
        bridge, _ = bridge_with(handler)
        assert asyncio.run(bridge.recall(GROUP)) is None
        assert asyncio.run(bridge.boot(GROUP)) is None
        asyncio.run(bridge.turn_end(GROUP, "嗯"))


def test_unconfigured_bridge_sends_nothing():
    bridge = KiokuBridge("", "")
    assert not bridge.enabled
    assert asyncio.run(bridge.recall(GROUP)) is None


def test_status_errors_redirects_config_hygiene_and_id_clipping(caplog):
    # legacy_key 给出 AstrBot 专属指引；503 legacy_database 与 database_unavailable 以及 3xx 都打清楚日志且不泄露密钥
    caplog.set_level("WARNING")
    responses = [
        httpx.Response(401, json={"error": "legacy", "code": "legacy_key"}),
        httpx.Response(503, json={"error": "legacy db", "code": "legacy_database"}),
        httpx.Response(503, json={"error": "db down", "code": "database_unavailable"}),
        httpx.Response(302, headers={"location": "https://other.example.com/v1/lifecycle/event"}),
        httpx.Response(
            200,
            json={
                "hostOutput": {"mode": "stdout_json", "value": {"hookSpecificOutput": {}}},
                "shortIds": [],
            },
        ),
    ]
    bridge, _ = bridge_with(lambda _r: responses.pop(0))
    for _ in range(4):
        assert asyncio.run(bridge.recall(GROUP)) is None
    assert asyncio.run(bridge.recall(GROUP)) is None
    assert "「客户端」页" in caplog.text
    assert "cli migrate" not in caplog.text
    assert "/legacy-upgrade" in caplog.text
    assert "database_unavailable" in caplog.text
    assert "HTTP 302" in caplog.text
    assert "runtime" in caplog.text or "astrbot" in caplog.text
    assert "kioku_test" not in caplog.text

    # 空白包裹的 URL/Key 自动 strip，且关闭 trust_env 与重定向跟随；含内部空白的 Key 直接禁用
    padded = KiokuBridge(" https://kioku.example.com/ ", " kioku_padded ")
    assert padded.enabled
    client = padded._client.get_async_httpx_client()
    assert client.trust_env is False
    assert client.follow_redirects is False

    bad_key = KiokuBridge("https://kioku.example.com", "bad key\n")
    assert not bad_key.enabled
    assert "bad key" not in caplog.text

    # sender_id / group_id 按 UTF-16 200 码元截断；空 session_id / 空 sender_id 不上报
    emoji_bridge, sent = bridge_with(answer("<recall>…</recall>"))
    long_id_turn = Turn(
        platform="aiocqhttp",
        session_id="aiocqhttp:GroupMessage:1",
        group_id="😀" * 150,
        sender_id="😀" * 150,
        sender_name="名",
        text="你好",
    )
    asyncio.run(emoji_bridge.recall(long_id_turn))
    assert len(sent[0]["context"]["sender"]["id"].encode("utf-16-le")) == MAX_SESSION_ID * 2
    assert len(sent[0]["context"]["group"]["id"].encode("utf-16-le")) == MAX_SESSION_ID * 2

    asyncio.run(
        emoji_bridge.turn_end(
            Turn(
                platform="aiocqhttp",
                session_id="   ",
                group_id=None,
                sender_id="1001",
                sender_name=None,
                text="你好",
            ),
            "嗯",
        )
    )
    asyncio.run(
        emoji_bridge.recall(
            Turn(
                platform="aiocqhttp",
                session_id="s1",
                group_id=None,
                sender_id="  ",
                sender_name=None,
                text="你好",
            )
        )
    )
    assert len(sent) == 1
