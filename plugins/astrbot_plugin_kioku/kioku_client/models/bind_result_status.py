from enum import StrEnum


class BindResultStatus(StrEnum):
    MERGED = "merged"
    PENDING = "pending"
    PREVIEW = "preview"

    def __str__(self) -> str:
        return str(self.value)
