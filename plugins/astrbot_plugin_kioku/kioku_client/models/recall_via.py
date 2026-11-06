from enum import StrEnum


class RecallVia(StrEnum):
    FULLTEXT = "fulltext"
    GLOSSARY = "glossary"
    SEMANTIC = "semantic"

    def __str__(self) -> str:
        return str(self.value)
