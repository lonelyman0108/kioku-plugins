from enum import StrEnum


class SubjectFactsRole(StrEnum):
    GROUP = "group"
    SENDER = "sender"

    def __str__(self) -> str:
        return str(self.value)
