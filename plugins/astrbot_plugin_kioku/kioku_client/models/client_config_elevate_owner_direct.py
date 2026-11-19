from enum import StrEnum


class ClientConfigElevateOwnerDirect(StrEnum):
    INTERNAL = "internal"

    def __str__(self) -> str:
        return str(self.value)
