from enum import StrEnum


class AppConfigElevateOwnerDirect(StrEnum):
    INTERNAL = "internal"

    def __str__(self) -> str:
        return str(self.value)
