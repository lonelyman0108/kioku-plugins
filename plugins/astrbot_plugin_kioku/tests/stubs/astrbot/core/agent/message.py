class TextPart:
    def __init__(self, text: str) -> None:
        self.text = text
        self.temp = False

    def mark_as_temp(self) -> "TextPart":
        self.temp = True
        return self
