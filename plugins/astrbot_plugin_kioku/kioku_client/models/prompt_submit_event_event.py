from enum import StrEnum


class PromptSubmitEventEvent(StrEnum):
    PROMPT_SUBMIT = "prompt.submit"

    def __str__(self) -> str:
        return str(self.value)
