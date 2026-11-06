from enum import StrEnum


class TurnEndEventEvent(StrEnum):
    TURN_END = "turn.end"

    def __str__(self) -> str:
        return str(self.value)
