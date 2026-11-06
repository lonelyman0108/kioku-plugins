"""/bind：用构造的 AstrBot 事件走一遍私聊申请、私聊预览与确认、群里作废公开了的码，以及 Kioku 出错时的回复。

命令后面的整段文字都当作码（码可能被分成几段抄），末尾带「确认」时是确认合并。
绑定码不交给模型：命令处理完就停止事件传播，这一轮不会请求模型，也不会进对话缓冲。
"""

import asyncio
import json

import httpx
from astrbot.api.event import AstrMessageEvent
from astrbot.api.star import Context
from astrbot_plugin_kioku.bridge import (
    BOUND,
    CONFIRM_NEEDS_CODE,
    GROUP_HINT,
    GROUP_PUBLIC,
    GROUP_VOIDED,
    NOT_CONFIGURED,
    UNAVAILABLE,
    WAITING,
    KiokuBridge,
    command_args,
    parse_code,
)
from astrbot_plugin_kioku.main import KiokuPlugin

PRIVATE_QQ = {
    "platform": "aiocqhttp",
    "session": "aiocqhttp:FriendMessage:1001",
    "sender_id": "1001",
    "sender_name": "小明",
}
PRIVATE_TG = {
    "platform": "telegram",
    "session": "telegram:FriendMessage:u1",
    "sender_id": "u1",
    "sender_name": "明",
}
GROUP = {
    "platform": "aiocqhttp",
    "session": "aiocqhttp:GroupMessage:2001",
    "group_id": "2001",
    "sender_id": "1002",
    "sender_name": "群名片",
}
TG_CONTEXT = {
    "chatType": "direct",
    "platform": "telegram",
    "sender": {"id": "u1", "name": "明"},
}


def plugin_answering(handler) -> tuple[KiokuPlugin, list[tuple[str, dict]]]:
    """插件发出的请求记下路径与正文，由 handler 决定 Kioku 怎么回。"""
    sent: list[tuple[str, dict]] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append((request.url.path, json.loads(request.content)))
        return handler(request)

    plugin = KiokuPlugin(Context(), {"kioku_url": "https://kioku.example.com", "kioku_key": "k"})
    plugin.bridge = KiokuBridge(
        "https://kioku.example.com", "k", transport=httpx.MockTransport(record)
    )
    return plugin, sent


def replies(plugin: KiokuPlugin, event: AstrMessageEvent) -> list[str]:
    async def run() -> list[str]:
        return [result.text async for result in plugin.bind(event)]

    return asyncio.run(run())


def preview(needs_approval: bool = False, display_name: str | None = "小明"):
    return lambda _r: httpx.Response(
        200,
        json={
            "status": "preview",
            "target": {
                "platform": "aiocqhttp",
                "displayName": display_name,
                "accountHint": "10***01",
            },
            "needsApproval": needs_approval,
            "expiresAt": None,
        },
    )


def test_command_text_is_split_into_code_and_confirmation():
    # AstrBot 交来的消息可能带着唤醒前缀，也可能已经去掉了
    assert command_args("/bind ABCD 2345") == "ABCD 2345"
    assert command_args("bind abcd-2345 确认") == "abcd-2345 确认"
    assert command_args("/bind") == ""
    # Telegram 的命令常带着机器人名
    assert command_args("/bind@MyBot ABCD 2345") == "ABCD 2345"
    assert command_args("/bind@MyBot") == ""
    assert parse_code("ABCD 2345") == ("ABCD2345", False)
    assert parse_code(" abcd-2345 确认 ") == ("abcd-2345", True)
    assert parse_code("ABCD2345确认") == ("ABCD2345", True)
    assert parse_code("ABCD 2345 Confirm") == ("ABCD2345", True)
    assert parse_code("确认 ABCD2345") == ("ABCD2345", True)
    assert parse_code("确认") == ("", True)
    assert parse_code("") == ("", False)


def test_private_bind_gets_a_code_and_says_how_to_use_it():
    plugin, sent = plugin_answering(
        lambda _r: httpx.Response(
            200,
            json={
                "code": "ABCD2345",
                "expiresAt": "2026-10-29T12:10:00.000Z",
                "expiresInSeconds": 600,
            },
        )
    )
    event = AstrMessageEvent(**PRIVATE_QQ, text="/bind")
    assert replies(plugin, event) == [
        "绑定码：ABCD2345\n10 分钟内到另一个平台私聊我，发「/bind ABCD2345」。"
    ]
    # 平台账号原样上报，由 Kioku 认出是谁在申请
    assert sent == [
        (
            "/v1/bind/code",
            {
                "context": {
                    "chatType": "direct",
                    "platform": "aiocqhttp",
                    "sender": {"id": "1001", "name": "小明"},
                }
            },
        )
    ]
    # 绑定码不交给模型
    assert event.is_stopped()


def test_a_code_first_shows_whom_it_binds_to_and_how_to_confirm():
    plugin, sent = plugin_answering(preview())
    # 码被分成两段抄也认得
    event = AstrMessageEvent(**PRIVATE_TG, text="bind abcd 2345")
    assert replies(plugin, event) == [
        (
            "要把这个账号绑到 aiocqhttp 上的「小明」（10***01）。"
            "绑定后两边私聊里记下的内容互相读得到，不能撤销。\n"
            "确认请发：/bind ABCD2345 确认"
        )
    ]
    assert sent == [("/v1/bind", {"code": "abcd2345", "context": TG_CONTEXT, "confirm": False})]
    assert event.is_stopped()

    # 对方标记了成员时说清还要对方同意；没有平台上的名字时只给露出头尾的账号
    plugin, _ = plugin_answering(preview(needs_approval=True, display_name=None))
    assert replies(plugin, AstrMessageEvent(**PRIVATE_TG, text="bind ABCD2345")) == [
        (
            "要把这个账号绑到 aiocqhttp 上的账号 10***01。"
            "绑定后两边私聊里记下的内容互相读得到，不能撤销。\n"
            "确认之后还要对方在管理界面同意。\n"
            "确认请发：/bind ABCD2345 确认"
        )
    ]


def test_telegram_commands_with_the_bot_name_are_understood():
    # 私聊里带着机器人名发码：照样先预览，不会去申请新码
    plugin, sent = plugin_answering(preview())
    event = AstrMessageEvent(**PRIVATE_TG, text="/bind@MyBot ABCD 2345")
    assert replies(plugin, event)[0].startswith("要把这个账号绑到")
    assert sent == [("/v1/bind", {"code": "ABCD2345", "context": TG_CONTEXT, "confirm": False})]
    # 群里带着机器人名发码：照样作废
    plugin, sent = plugin_answering(lambda _r: httpx.Response(204))
    event = AstrMessageEvent(**GROUP, text="/bind@MyBot ABCD2345")
    assert replies(plugin, event) == [GROUP_VOIDED]
    assert [path for path, _ in sent] == ["/v1/bind/void"]


def test_confirming_without_a_code_asks_for_it_and_does_not_issue_a_new_one():
    for text in ("/bind 确认", "/bind confirm", "/bind@MyBot 确认"):
        plugin, sent = plugin_answering(lambda _r: httpx.Response(500))
        event = AstrMessageEvent(**PRIVATE_TG, text=text)
        assert replies(plugin, event) == [CONFIRM_NEEDS_CODE]
        assert event.is_stopped()
        assert sent == []


def test_confirming_binds_or_waits_for_the_member():
    for status, reply in (("merged", BOUND), ("pending", WAITING)):
        plugin, sent = plugin_answering(
            lambda _r, status=status: httpx.Response(
                200,
                json={
                    "status": status,
                    "needsApproval": status == "pending",
                    "expiresAt": None if status == "merged" else "2026-11-05T12:00:00.000Z",
                },
            )
        )
        event = AstrMessageEvent(**PRIVATE_TG, text="/bind ABCD-2345 确认")
        assert replies(plugin, event) == [reply]
        assert sent == [("/v1/bind", {"code": "ABCD-2345", "context": TG_CONTEXT, "confirm": True})]
        assert event.is_stopped()


def test_a_code_sent_in_a_group_is_voided():
    plugin, sent = plugin_answering(lambda _r: httpx.Response(204))
    event = AstrMessageEvent(**GROUP, text="/bind ABCD 2345")
    # 群里的人都看得到这个码：作废它，不合并
    assert replies(plugin, event) == [GROUP_VOIDED]
    assert sent == [
        (
            "/v1/bind/void",
            {
                "code": "ABCD2345",
                "context": {
                    "chatType": "group",
                    "platform": "aiocqhttp",
                    "group": {"id": "2001"},
                    "sender": {"id": "1002", "name": "群名片"},
                },
            },
        )
    ]
    assert event.is_stopped()

    # 带着确认词发也只作废
    plugin, sent = plugin_answering(lambda _r: httpx.Response(204))
    assert replies(plugin, AstrMessageEvent(**GROUP, text="/bind ABCD2345 确认")) == [GROUP_VOIDED]
    assert [path for path, _ in sent] == ["/v1/bind/void"]

    # 作废不成（输错太多、连不上）时也提醒码已经公开了，去私聊重新申请（新码会让旧码作废）
    def down(_request):
        raise httpx.ConnectError("连不上")

    for handler in (
        down,
        lambda _r: httpx.Response(429, json={"error": "输错次数过多，请 37 分钟后重试"}),
    ):
        plugin, _ = plugin_answering(handler)
        assert replies(plugin, AstrMessageEvent(**GROUP, text="/bind ABCD2345")) == [GROUP_PUBLIC]


def test_group_bind_without_a_code_only_points_to_private_chat():
    plugin, sent = plugin_answering(lambda _r: httpx.Response(500))
    event = AstrMessageEvent(**GROUP, text="/bind")
    assert replies(plugin, event) == [GROUP_HINT]
    assert event.is_stopped()
    assert sent == []


def test_kioku_errors_are_relayed_and_failures_degrade():
    # Kioku 的说明原样转达：码不对、输错太多、Key 写不了对象层……
    for status, error in (
        (400, "绑定码错误或已失效，请重新申请"),
        (429, "输错次数过多，请 37 分钟后重试"),
        (403, "当前 bot 的 Key 无权写入联系人层，无法绑定账号"),
    ):
        plugin, _ = plugin_answering(
            lambda _r, status=status, error=error: httpx.Response(status, json={"error": error})
        )
        assert replies(plugin, AstrMessageEvent(**PRIVATE_TG, text="/bind ABCD2345")) == [error]

    def down(_request):
        raise httpx.ConnectError("连不上")

    # Key 无效是 bot 主人的配置问题，连不上、服务端出错都只回一句
    for handler in (
        down,
        lambda _r: httpx.Response(401, json={"error": "未登录或凭据无效"}),
        lambda _r: httpx.Response(500, text="服务内部错误"),
    ):
        plugin, _ = plugin_answering(handler)
        event = AstrMessageEvent(**PRIVATE_QQ, text="/bind")
        assert replies(plugin, event) == [UNAVAILABLE]
        assert event.is_stopped()


def test_too_long_codes_are_clipped_to_what_kioku_accepts():
    plugin, sent = plugin_answering(
        lambda _r: httpx.Response(400, json={"error": "绑定码由 8 位字母和数字组成"})
    )
    event = AstrMessageEvent(**PRIVATE_TG, text="/bind " + "A" * 200)
    assert replies(plugin, event) == ["绑定码由 8 位字母和数字组成"]
    assert sent[0][1]["code"] == "A" * 64


def test_unconfigured_plugin_says_so():
    plugin = KiokuPlugin(Context(), {"kioku_url": "", "kioku_key": ""})
    event = AstrMessageEvent(**PRIVATE_QQ, text="/bind")
    assert replies(plugin, event) == [NOT_CONFIGURED]
    assert event.is_stopped()
