from enum import StrEnum


class EntryViewKind(StrEnum):
    ENTRY = "entry"
    EPISODE = "episode"
    FACT = "fact"

    def __str__(self) -> str:
        return str(self.value)
