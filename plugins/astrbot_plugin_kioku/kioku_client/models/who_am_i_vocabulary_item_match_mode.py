from enum import StrEnum


class WhoAmIVocabularyItemMatchMode(StrEnum):
    ADDITIVE = "additive"
    EXCLUSIVE = "exclusive"

    def __str__(self) -> str:
        return str(self.value)
