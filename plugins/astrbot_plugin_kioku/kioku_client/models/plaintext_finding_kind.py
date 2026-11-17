from enum import StrEnum


class PlaintextFindingKind(StrEnum):
    AWS = "aws"
    CUSTOM = "custom"
    GITHUB = "github"
    GITLAB = "gitlab"
    HEADER_SECRET = "header_secret"
    JWT = "jwt"
    KIOKU = "kioku"
    LABEL = "label"
    PRIVATE_KEY = "private_key"
    PROVIDER_TOKEN = "provider_token"
    SEED_PHRASE = "seed_phrase"
    SK = "sk"
    SLACK = "slack"
    URL_PASSWORD = "url_password"
    WALLET_KEY = "wallet_key"

    def __str__(self) -> str:
        return str(self.value)
