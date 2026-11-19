from enum import StrEnum


class GetV1EntriesBrowseGroupBy(StrEnum):
    CIRCLE = "circle"
    ENV = "env"
    KIND = "kind"
    PROJECT = "project"
    REALM = "realm"
    RUNTIME = "runtime"
    TOPIC = "topic"

    def __str__(self) -> str:
        return str(self.value)
