from enum import StrEnum


class RecallCandidateKind(StrEnum):
    ENTRY = "entry"
    EPISODE = "episode"
    FACT = "fact"

    def __str__(self) -> str:
        return str(self.value)
