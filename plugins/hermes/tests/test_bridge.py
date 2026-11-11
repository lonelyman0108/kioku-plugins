import json
import threading

import pytest
from hermes.kioku_bridge import (
    KiokuClient,
    KiokuFailure,
    KiokuSession,
    context_of,
    is_trivial,
    key_problem,
    server_url_problem,
    tool_result,
    tool_schemas,
)

KEY = "kioku_test_key"


def session(kioku, key=KEY, url=None):
    return KiokuSession(lambda: KiokuClient(url or kioku.url, key))


def events(kioku):
    return [r["body"].get("event") or r["body"].get("method") for r in kioku.requests]


def body_of(kioku, name):
    return next(
        r["body"]
        for r in kioku.requests
        if name in (r["body"].get("event"), r["body"].get("method"))
    )


def test_local_session_boots_recalls_and_reports(kioku, tmp_path):
    s = session(kioku)
    s.start("s1", platform="cli", cwd=str(tmp_path), agent_context="primary")
    assert s.active
    assert s.boot() == "<启动加载>"
    assert body_of(kioku, "session.start") == {
        "event": "session.start",
        "sessionId": "s1",
        "project": {"dirName": tmp_path.name},
    }
    assert all(r["auth"] == f"Bearer {KEY}" for r in kioku.requests)

    assert s.recall("  办公室的网络怎么配的  ") == "<召回>"
    assert body_of(kioku, "prompt.submit")["prompt"] == "办公室的网络怎么配的"

    s.turn_end(" 问 ", " 答 ")
    s.flush()
    assert body_of(kioku, "turn.end") == {
        "event": "turn.end",
        "sessionId": "s1",
        "user": "问",
        "reply": "答",
    }


def test_tools_are_listed_before_start_and_routed(kioku):
    # Hermes 在初始化之前就按这份清单登记工具的归属
    s = session(kioku)
    names = [tool["name"] for tool in s.tools()]
    assert names == ["kioku_get", "kioku_search"]
    assert s.tools()[0]["parameters"] == {
        "type": "object",
        "properties": {"uri": {"type": "string"}},
    }
    assert s.tools()[1]["parameters"] == {"type": "object", "properties": {}}
    s.start("s1", platform="cli")
    # 清单只取一次
    assert events(kioku).count("tools/list") == 1
    assert [tool["name"] for tool in s.tools()] == names
    assert json.loads(s.call_tool("kioku_get", {"uri": "user://a"})) == {
        "result": "调用了 kioku_get"
    }
    assert body_of(kioku, "tools/call")["params"] == {
        "name": "kioku_get",
        "arguments": {"uri": "user://a"},
    }
    # 不是 Kioku 的工具不转发
    assert "error" in json.loads(s.call_tool("rm_rf", {}))
    assert events(kioku).count("tools/call") == 1


@pytest.mark.parametrize("platform", ["cli", "tui", "gui", "acp", "desktop"])
def test_local_platforms(kioku, platform):
    s = session(kioku)
    s.start("s1", platform=platform)
    assert s.active


def test_tools_missed_at_registration_stay_missing(kioku):
    # 登记时没取到：之后不补取，免得模型看得到却调不通
    kioku.replies = {"tools/list": (500, {}, {})}
    s = session(kioku)
    assert s.tools() == []
    kioku.replies = {}
    s.start("s1", platform="cli")
    assert s.active and s.tools() == []
    assert events(kioku).count("tools/list") == 1
    assert "error" in json.loads(s.call_tool("kioku_get", {}))


def test_concurrent_tool_listing_fetches_once_and_all_see_the_list(kioku):
    kioku.gate = threading.Event()
    s = session(kioku)
    results = []
    threads = [threading.Thread(target=lambda: results.append(len(s.tools()))) for _ in range(4)]
    for t in threads:
        t.start()
    kioku.gate.set()
    for t in threads:
        t.join(5)
    assert results == [2, 2, 2, 2]
    assert events(kioku).count("tools/list") == 1


@pytest.mark.parametrize(
    "kwargs",
    [
        {"platform": "telegram", "gateway_session_key": "tg:1"},
        {"platform": "discord", "chat_id": "42"},
        # API 服务器在调用方不带会话头时两个标识都没有：照样不启用
        {"platform": "api_server"},
        {"platform": "cron"},
        {"platform": "以后新出的入口"},
        {},
        # 本机的入口带着网关的标识也不启用
        {"platform": "cli", "gateway_session_key": "x"},
    ],
)
def test_only_local_platforms_are_enabled(kioku, kwargs):
    s = session(kioku)
    registered = s.tools()
    assert registered
    kioku.requests.clear()
    s.start("s1", **kwargs)
    assert not s.active
    assert s.boot() == ""
    assert s.recall("问") == ""
    # 模型看不到工具；登记还在，调用时拒绝
    assert s.tools() == []
    assert "error" in json.loads(s.call_tool("kioku_get", {"uri": "user://a"}))
    s.turn_end("问", "答")
    s.flush()
    assert kioku.requests == []


def test_non_primary_contexts_do_not_report(kioku):
    s = session(kioku)
    s.start("s1", platform="cli", agent_context="subagent")
    assert s.recall("问") == "<召回>"
    s.turn_end("问", "答")
    s.flush()
    assert "turn.end" not in events(kioku)


def test_empty_sides_and_missing_session_do_not_report(kioku):
    s = session(kioku)
    s.start("", platform="cli")
    s.turn_end("问", "答")
    s.switch("s2")
    s.turn_end("", "答")
    s.turn_end("问", "  ")
    s.flush()
    assert "turn.end" not in events(kioku)
    s.turn_end("问", "答")
    s.flush()
    assert body_of(kioku, "turn.end")["sessionId"] == "s2"


def test_failures_never_raise_and_never_leak_the_key(kioku, caplog):
    kioku.replies = {
        "session.start": (500, {}, {}),
        "prompt.submit": (302, {}, {"location": "https://kioku.example.com/x"}),
        "tools/list": (200, b"not json", {}),
        "turn.end": (401, {"error": KEY}, {}),
    }
    s = session(kioku)
    s.start("s1", platform="cli")
    assert s.active
    assert s.boot() == ""
    assert s.recall("问") == ""
    assert s.tools() == []
    s.turn_end("问", "答")
    s.flush()
    text = caplog.text
    assert "HTTP 500" in text and "跳转（302）" in text and "HTTP 401" in text
    assert KEY not in text
    # 跳转没有被跟着走
    assert all(r["path"].startswith("/v1/") for r in kioku.requests)


def test_unreachable_server_and_bad_config(caplog):
    s = KiokuSession(lambda: KiokuClient("http://127.0.0.1:1", KEY))
    s.start("s1", platform="cli")
    assert s.boot() == "" and s.recall("问") == "" and s.tools() == []
    assert "无法连接 Kioku" in caplog.text

    for url, key in [("", KEY), ("ftp://x", KEY), ("http://127.0.0.1:1", "bad key")]:
        bad = KiokuSession(lambda url=url, key=key: KiokuClient(url, key))
        assert bad.tools() == []
        bad.start("s1", platform="cli")
        assert not bad.active and bad.inactive_reason
    assert "bad key" not in caplog.text


def test_turn_end_runs_in_background_and_flush_waits(kioku):
    s = session(kioku)
    s.start("s1", platform="cli")
    kioku.gate = threading.Event()
    s.turn_end("问", "答")  # 服务端还没回答，这里立刻返回
    waiter = threading.Thread(target=s.flush)
    waiter.start()
    waiter.join(0.2)
    assert waiter.is_alive()
    kioku.gate.set()
    waiter.join(5)
    assert not waiter.is_alive()


def test_long_text_is_clipped(kioku):
    s = session(kioku)
    s.start("s1", platform="cli")
    s.recall("问" * 20_001)
    s.turn_end("问" * 20_001, "😀" * 20_001)
    s.flush()
    assert len(body_of(kioku, "prompt.submit")["prompt"]) == 20_000
    assert len(body_of(kioku, "turn.end")["user"]) == 20_000
    assert len(body_of(kioku, "turn.end")["reply"]) == 20_000


def test_event_stream_answers_from_the_tool_endpoint(kioku):
    stream = "event: message\ndata: " + json.dumps(
        {"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "kioku_get"}]}}
    )
    kioku.replies = {"tools/list": (200, stream.encode(), {"content-type": "text/event-stream"})}
    assert [tool["name"] for tool in session(kioku).tools()] == ["kioku_get"]


def test_helpers():
    assert context_of({"mode": "return_value", "value": {"context": "甲"}}) == "甲"
    assert context_of({"mode": "stdout_text", "value": "乙"}) == "乙"
    assert (
        context_of(
            {"mode": "stdout_json", "value": {"hookSpecificOutput": {"additionalContext": "丙"}}}
        )
        == "丙"
    )
    assert context_of({"mode": "none", "value": None}) == ""
    assert context_of({"mode": "return_value", "value": {"context": 1}}) == ""
    # 形状不对的不抛错
    for odd in [None, "x", ["x"], {"mode": "stdout_json", "value": {"hookSpecificOutput": "x"}}]:
        assert context_of(odd) == ""

    # 清单不是列表、里面不是对象的都跳过
    assert tool_schemas({"tools": "坏的"}) == []
    assert tool_schemas({}) == []
    assert json.loads(tool_result({"content": [{"type": "text", "text": "好"}]})) == {
        "result": "好"
    }
    assert json.loads(
        tool_result({"isError": True, "content": [{"type": "text", "text": "坏"}]})
    ) == {"error": "坏"}

    assert server_url_problem("https://kioku.example.com") is None
    for url in [
        "",
        "kioku.example.com",
        "https://u:p@x",
        "https://x/?a=1",
        "https://x/a b",
        "https://x\n",
    ]:
        assert server_url_problem(url)
    assert key_problem("kioku_abc") is None
    assert key_problem("") and key_problem("a b") and key_problem("密钥")
    # 结尾带换行的也不行
    assert key_problem("kioku_abc\n")

    for text in ["", "  ", "/help", "ok", "好的", "谢谢！", "继续。"]:
        assert is_trivial(text)
    for text in ["部署怎么做", "ok 那数据库呢", "k8s"]:
        assert not is_trivial(text)


def test_client_rejects_bad_config_without_requests():
    with pytest.raises(KiokuFailure):
        KiokuClient("http://127.0.0.1:1", "a b")


def test_proxies_from_the_environment_are_not_used(kioku, monkeypatch):
    # 环境里配了连不上的代理：请求照样直接到 Kioku
    for name in ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]:
        monkeypatch.setenv(name, "http://127.0.0.1:1")
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    s = session(kioku)
    s.start("s1", platform="cli")
    assert s.boot() == "<启动加载>"


def test_odd_responses_and_urls_never_raise(kioku, caplog):
    kioku.replies = {
        "session.start": (200, {"hostOutput": "不是对象"}, {}),
        "prompt.submit": (200, ["不是对象"], {}),
    }
    s = session(kioku)
    s.start("s1", platform="cli")
    assert s.boot() == "" and s.recall("问") == ""
    # 地址里有编不进请求的字符：不抛到外面，日志里不带访问密钥
    odd = KiokuSession(lambda: KiokuClient(kioku.url + "/路径", KEY))
    odd.start("s1", platform="cli")
    assert odd.boot() == ""
    assert KEY not in caplog.text


def test_turns_reach_the_server_in_order(kioku):
    s = session(kioku)
    s.start("s1", platform="cli")
    for index in range(8):
        s.turn_end(f"问 {index}", "答")
    s.flush()
    users = [r["body"]["user"] for r in kioku.requests if r["body"].get("event") == "turn.end"]
    assert users == [f"问 {index}" for index in range(8)]
