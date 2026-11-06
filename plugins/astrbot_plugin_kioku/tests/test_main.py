"""插件的钩子：用构造的 AstrBot 事件走一遍私聊、群聊与主人私聊，确认注入的位置与上报的对话。

主人私聊在插件这边和别人的私聊一样：平台账号原样上报，是不是主人由服务端按对象判断。
"""

import asyncio
import json

import httpx
from astrbot.api.event import AstrMessageEvent
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context
from astrbot_plugin_kioku.bridge import KiokuBridge
from astrbot_plugin_kioku.main import KiokuPlugin


def plugin_with(sent: list[dict], boot: bool = True) -> KiokuPlugin:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        context = {"session.start": "人格与基础规则", "prompt.submit": "<recall>…</recall>"}.get(
            body["event"]
        )
        value = {"context": context} if context else None
        return httpx.Response(
            200,
            json={
                "hostOutput": {"mode": "return_value" if value else "none", "value": value},
                "nodeUris": [],
            },
        )

    plugin = KiokuPlugin(
        Context(), {"kioku_url": "https://kioku.example.com", "kioku_key": "k", "boot": boot}
    )
    plugin.bridge = KiokuBridge(
        "https://kioku.example.com", "k", transport=httpx.MockTransport(handler)
    )
    return plugin


async def one_turn(plugin: KiokuPlugin, event: AstrMessageEvent) -> ProviderRequest:
    req = ProviderRequest(system_prompt="你是豆包。")
    await plugin.inject(event, req)
    await plugin.remember(event, LLMResponse(completion_text="还没定"))
    await plugin.terminate()
    return req


def test_group_turn_injects_boot_and_recall_and_reports_the_turn():
    sent: list[dict] = []
    event = AstrMessageEvent(
        platform="aiocqhttp",
        session="aiocqhttp:GroupMessage:2001",
        group_id="2001",
        sender_id="1002",
        sender_name="群名片",
        text="周五读什么",
    )
    plugin = plugin_with(sent)
    req = asyncio.run(one_turn(plugin, event))
    # 很少变的人格与基础规则进系统提示；每轮的召回作为临时的额外内容，不进对话历史
    assert req.system_prompt == "你是豆包。\n\n人格与基础规则"
    assert [(p.text, p.temp) for p in req.extra_user_content_parts] == [
        ("<recall>…</recall>", True)
    ]
    assert sorted(s["event"] for s in sent) == ["prompt.submit", "session.start", "turn.end"]
    turn_end = next(s for s in sent if s["event"] == "turn.end")
    assert turn_end["context"]["group"] == {"id": "2001"}
    assert turn_end["context"]["sender"] == {"id": "1002", "name": "群名片"}
    assert (turn_end["user"], turn_end["reply"]) == ("周五读什么", "还没定")
    # 停用或重载插件时等上报发完，再关掉连接池
    assert plugin.bridge._client.get_async_httpx_client().is_closed


def test_private_and_owner_private_turns_report_the_sender():
    for sender in ("1001", "10000"):
        sent: list[dict] = []
        event = AstrMessageEvent(
            platform="aiocqhttp",
            session=f"aiocqhttp:FriendMessage:{sender}",
            sender_id=sender,
            sender_name="小明",
            text="我在学日语",
        )
        asyncio.run(one_turn(plugin_with(sent), event))
        assert {s["context"]["chatType"] for s in sent} == {"direct"}
        assert {json.dumps(s["context"]["sender"], ensure_ascii=False) for s in sent} == {
            json.dumps({"id": sender, "name": "小明"}, ensure_ascii=False)
        }


def test_replies_after_terminate_are_not_reported():
    sent: list[dict] = []
    plugin = plugin_with(sent)
    event = AstrMessageEvent(
        platform="webchat", session="webchat:FriendMessage:admin", sender_id="admin", text="你好"
    )

    async def reload() -> None:
        await plugin.terminate()
        await plugin.remember(event, LLMResponse(completion_text="嗯"))
        # 停用时还在路上的回复不再上报：不建上报任务，不会撞上关掉的连接池
        assert not plugin._pending

    asyncio.run(reload())
    assert sent == []


def test_boot_can_be_turned_off():
    sent: list[dict] = []
    event = AstrMessageEvent(
        platform="webchat", session="webchat:FriendMessage:admin", sender_id="admin", text="你好"
    )
    req = asyncio.run(one_turn(plugin_with(sent, boot=False), event))
    assert req.system_prompt == "你是豆包。"
    assert "session.start" not in [s["event"] for s in sent]


def test_unconfigured_plugin_does_nothing():
    plugin = KiokuPlugin(Context(), {"kioku_url": "", "kioku_key": ""})
    event = AstrMessageEvent(platform="webchat", session="s", sender_id="admin", text="你好")
    req = asyncio.run(one_turn(plugin, event))
    assert req.system_prompt == "你是豆包。"
    assert req.extra_user_content_parts == []
