from enum import StrEnum


class RecallVia(StrEnum):
    FULLTEXT = "fulltext"
    GLOSSARY = "glossary"
    LINK = "link"
    SEMANTIC = "semantic"

    def __str__(self) -> str:
        return str(self.value)
