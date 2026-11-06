from enum import StrEnum


class HostOutputMode(StrEnum):
    NONE = "none"
    RETURN_VALUE = "return_value"
    STDOUT_JSON = "stdout_json"
    STDOUT_TEXT = "stdout_text"

    def __str__(self) -> str:
        return str(self.value)
