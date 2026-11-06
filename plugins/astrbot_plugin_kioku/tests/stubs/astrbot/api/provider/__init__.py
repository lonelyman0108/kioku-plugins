class ProviderRequest:
    def __init__(self, system_prompt: str = "") -> None:
        self.system_prompt = system_prompt
        self.extra_user_content_parts: list = []


class LLMResponse:
    def __init__(self, completion_text: str = "") -> None:
        self.completion_text = completion_text
