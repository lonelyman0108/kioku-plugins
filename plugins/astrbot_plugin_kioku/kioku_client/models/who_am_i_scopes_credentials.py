from enum import StrEnum


class WhoAmIScopesCredentials(StrEnum):
    MANAGE = "manage"
    NONE = "none"
    USE = "use"

    def __str__(self) -> str:
        return str(self.value)
