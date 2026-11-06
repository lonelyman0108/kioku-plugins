from enum import StrEnum


class MemoryViewLayer(StrEnum):
    APP = "app"
    CORE = "core"
    EPISODE = "episode"
    PERSONA = "persona"
    SUBJECT = "subject"
    USER = "user"

    def __str__(self) -> str:
        return str(self.value)
