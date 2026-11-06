from enum import StrEnum


class WhoAmIScopesMaxSensitivity(StrEnum):
    INTERNAL = "internal"
    PRIVATE = "private"
    PUBLIC = "public"
    SECRET = "secret"

    def __str__(self) -> str:
        return str(self.value)
