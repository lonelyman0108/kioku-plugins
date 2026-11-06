from enum import StrEnum


class SessionStartEventEvent(StrEnum):
    SESSION_START = "session.start"

    def __str__(self) -> str:
        return str(self.value)
