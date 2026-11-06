from enum import StrEnum


class ChatType(StrEnum):
    CHANNEL = "channel"
    CRON = "cron"
    DIRECT = "direct"
    GROUP = "group"
    SUBAGENT = "subagent"

    def __str__(self) -> str:
        return str(self.value)
