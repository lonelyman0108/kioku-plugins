from enum import StrEnum


class WhoAmILinkedCirclesItemMode(StrEnum):
    READ = "read"
    READ_WRITE = "read_write"

    def __str__(self) -> str:
        return str(self.value)
