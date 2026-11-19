from enum import StrEnum


class ClientConfigPersonMemoryMode(StrEnum):
    PERSONA_SHARED = "persona_shared"
    STRICT = "strict"

    def __str__(self) -> str:
        return str(self.value)
