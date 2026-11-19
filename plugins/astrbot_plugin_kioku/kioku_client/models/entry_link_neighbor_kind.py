from enum import StrEnum


class EntryLinkNeighborKind(StrEnum):
    ENTRY = "entry"
    EPISODE = "episode"
    FACT = "fact"

    def __str__(self) -> str:
        return str(self.value)
