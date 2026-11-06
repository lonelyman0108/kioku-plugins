class MessageEventResult:
    """插件回复的消息：替身里只留文字。"""

    def __init__(self, text: str) -> None:
        self.text = text


class AstrMessageEvent:
    """插件读到的事件：平台、会话、群、发言人与这一轮的文字。"""

    def __init__(
        self,
        *,
        platform: str,
        session: str,
        sender_id: str,
        sender_name: str = "",
        group_id: str = "",
        text: str = "",
    ) -> None:
        self._platform = platform
        self.unified_msg_origin = session
        self._sender_id = sender_id
        self._sender_name = sender_name
        self._group_id = group_id
        self.message_str = text
        self._stopped = False

    def get_platform_name(self) -> str:
        return self._platform

    def get_group_id(self) -> str:
        return self._group_id

    def get_sender_id(self) -> str:
        return self._sender_id

    def get_sender_name(self) -> str:
        return self._sender_name

    def plain_result(self, text: str) -> MessageEventResult:
        return MessageEventResult(text)

    def stop_event(self) -> None:
        """停止事件传播：后面的处理（包括请求模型）都不再做。"""
        self._stopped = True

    def is_stopped(self) -> bool:
        return self._stopped


class _Filter:
    """钩子的装饰器：替身里原样返回被装饰的函数。"""

    def on_llm_request(self):
        return lambda fn: fn

    def on_llm_response(self):
        return lambda fn: fn

    def command(self, _name: str):
        return lambda fn: fn


filter = _Filter()
