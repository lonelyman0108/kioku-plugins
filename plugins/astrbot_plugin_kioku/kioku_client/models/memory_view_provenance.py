from enum import StrEnum


class MemoryViewProvenance(StrEnum):
    AGENT = "agent"
    OWNER = "owner"
    SYSTEM = "system"
    UNTRUSTED = "untrusted"

    def __str__(self) -> str:
        return str(self.value)
