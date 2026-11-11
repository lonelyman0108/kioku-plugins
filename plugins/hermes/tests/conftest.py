"""假的 Kioku：记下收到的请求，按 replies 回答。"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

TOOLS = {
    "tools": [
        {
            "name": "kioku_get",
            "description": "读一条记忆",
            "inputSchema": {"type": "object", "properties": {"uri": {"type": "string"}}},
        },
        {"name": "kioku_search", "description": "搜索"},
        {"description": "没有名字的不算"},
    ]
}


class FakeKioku:
    def __init__(self):
        self.requests = []
        # 路径或事件名 → (状态码, 响应体, 响应头)；没写的用默认回答
        self.replies = {}
        self.gate = None

    def answer(self, path, body):
        key = body.get("event") or body.get("method") or path
        if key in self.replies:
            return self.replies[key]
        if path == "/v1/lifecycle/event":
            text = {"session.start": "<启动加载>", "prompt.submit": "<召回>"}.get(body["event"])
            output = (
                {"mode": "return_value", "value": {"context": text}}
                if text
                else {"mode": "none", "value": None}
            )
            return 200, {"hostOutput": output}, {}
        if body.get("method") == "tools/list":
            return 200, {"jsonrpc": "2.0", "id": 1, "result": TOOLS}, {}
        result = {"content": [{"type": "text", "text": f"调用了 {body['params']['name']}"}]}
        return 200, {"jsonrpc": "2.0", "id": 1, "result": result}, {}


@pytest.fixture
def kioku():
    fake = FakeKioku()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("content-length") or 0))
            body = json.loads(raw.decode("utf-8"))
            fake.requests.append(
                {"path": self.path, "auth": self.headers.get("authorization"), "body": body}
            )
            if fake.gate is not None:
                fake.gate.wait(5)
            status, payload, headers = fake.answer(self.path, body)
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", headers.get("content-type", "application/json"))
            for name, value in headers.items():
                if name != "content-type":
                    self.send_header(name, value)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()
    server.server_close()
