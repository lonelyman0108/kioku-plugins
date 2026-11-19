from enum import StrEnum


class WhoAmIPrimaryCircleKind(StrEnum):
    PERSONAL = "personal"
    SHARED = "shared"

    def __str__(self) -> str:
        return str(self.value)
