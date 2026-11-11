import json

import hermes
from hermes import KiokuMemoryProvider, register

KEY = "kioku_test_key"


def provider(monkeypatch, url, key=KEY):
    monkeypatch.setenv("KIOKU_SERVER_URL", url)
    monkeypatch.setenv("KIOKU_API_KEY", key)
    return KiokuMemoryProvider()


def test_register_hands_hermes_a_fresh_instance():
    seen = []

    class Ctx:
        def register_memory_provider(self, p):
            seen.append(p)

    register(Ctx())
    register(Ctx())
    assert len(seen) == 2 and seen[0] is not seen[1]
    assert seen[0].name == "kioku"


def test_availability_reads_config_only(monkeypatch):
    monkeypatch.delenv("KIOKU_SERVER_URL", raising=False)
    monkeypatch.delenv("KIOKU_API_KEY", raising=False)
    p = KiokuMemoryProvider()
    assert not p.is_available()
    assert "hermes memory setup" in p.unavailable_reason()
    monkeypatch.setenv("KIOKU_SERVER_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("KIOKU_API_KEY", "bad key")
    assert not p.is_available()
    assert "bad key" not in p.unavailable_reason()
    # 能用不能用只看配置，不发请求：指着连不上的地址也算能用
    monkeypatch.setenv("KIOKU_API_KEY", KEY)
    assert p.is_available() and p.unavailable_reason() == ""


def test_config_schema_keeps_both_fields_in_env():
    fields = {f["key"]: f for f in KiokuMemoryProvider().get_config_schema()}
    assert fields["server_url"]["env_var"] == "KIOKU_SERVER_URL"
    assert fields["api_key"]["env_var"] == "KIOKU_API_KEY"
    assert fields["api_key"]["secret"] is True
    assert not fields["server_url"].get("secret")


def test_callbacks_reach_kioku(monkeypatch, kioku, tmp_path):
    p = provider(monkeypatch, kioku.url)
    # 登记工具在初始化之前
    assert [t["name"] for t in p.get_tool_schemas()] == ["kioku_get", "kioku_search"]
    p.initialize("s1", hermes_home=str(tmp_path), platform="cli", cwd=str(tmp_path))
    assert p.system_prompt_block() == "<启动加载>"
    assert p.prefetch("部署怎么做", session_id="s1") == "<召回>"
    # 没有内容的输入不召回
    before = len(kioku.requests)
    assert p.prefetch("ok") == ""
    assert len(kioku.requests) == before
    assert json.loads(p.handle_tool_call("kioku_get", {"uri": "user://a"}, hermes_home="x")) == {
        "result": "调用了 kioku_get"
    }
    p.sync_turn("问", "答", session_id="s1", messages=[], turn_author={"id": "u"})
    p.on_session_switch("s2", parent_session_id="s1", reset=False)
    p.sync_turn("再问", "再答")
    p.shutdown()
    ends = [r["body"] for r in kioku.requests if r["body"].get("event") == "turn.end"]
    assert [(b["sessionId"], b["user"]) for b in ends] == [("s1", "问"), ("s2", "再问")]


def test_works_without_the_newer_hermes_helpers():
    # 发布版的 Hermes 没有 is_trivial_prompt 与 spawn_context_thread：有就用，没有也要能加载
    assert callable(hermes.is_trivial_prompt)
