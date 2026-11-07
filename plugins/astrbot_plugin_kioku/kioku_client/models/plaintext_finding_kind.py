from enum import StrEnum


class PlaintextFindingKind(StrEnum):
    AWS = "aws"
    GITHUB = "github"
    GITLAB = "gitlab"
    JWT = "jwt"
    KIOKU = "kioku"
    LABEL = "label"
    PRIVATE_KEY = "private_key"
    SK = "sk"
    SLACK = "slack"

    def __str__(self) -> str:
        return str(self.value)
