from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.client_config import ClientConfig


T = TypeVar("T", bound="ClientInfo")


@_attrs_define
class ClientInfo:
    """
    Attributes:
        id (UUID):
        circle_id (UUID):
        slug (str):
        name (str):
        runtime_family (str):
        owner_account_id (UUID):
        default_persona_id (None | UUID):
        config (ClientConfig):
    """

    id: UUID
    circle_id: UUID
    slug: str
    name: str
    runtime_family: str
    owner_account_id: UUID
    default_persona_id: None | UUID
    config: ClientConfig
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.client_config import ClientConfig  # noqa: PLC0415

        id = str(self.id)

        circle_id = str(self.circle_id)

        slug = self.slug

        name = self.name

        runtime_family = self.runtime_family

        owner_account_id = str(self.owner_account_id)

        default_persona_id: None | str
        if isinstance(self.default_persona_id, UUID):
            default_persona_id = str(self.default_persona_id)
        else:
            default_persona_id = self.default_persona_id

        config = self.config.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "circleId": circle_id,
                "slug": slug,
                "name": name,
                "runtimeFamily": runtime_family,
                "ownerAccountId": owner_account_id,
                "defaultPersonaId": default_persona_id,
                "config": config,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.client_config import ClientConfig  # noqa: PLC0415

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        circle_id = UUID(d.pop("circleId"))

        slug = d.pop("slug")

        name = d.pop("name")

        runtime_family = d.pop("runtimeFamily")

        owner_account_id = UUID(d.pop("ownerAccountId"))

        def _parse_default_persona_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                default_persona_id_type_0 = UUID(data)

                return default_persona_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        default_persona_id = _parse_default_persona_id(d.pop("defaultPersonaId"))

        config = ClientConfig.from_dict(d.pop("config"))

        client_info = cls(
            id=id,
            circle_id=circle_id,
            slug=slug,
            name=name,
            runtime_family=runtime_family,
            owner_account_id=owner_account_id,
            default_persona_id=default_persona_id,
            config=config,
        )

        client_info.additional_properties = d
        return client_info

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
