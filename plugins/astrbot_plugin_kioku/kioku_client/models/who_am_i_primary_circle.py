from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.who_am_i_primary_circle_kind import WhoAmIPrimaryCircleKind
from uuid import UUID


T = TypeVar("T", bound="WhoAmIPrimaryCircle")


@_attrs_define
class WhoAmIPrimaryCircle:
    """
    Attributes:
        id (UUID):
        slug (str):
        name (str):
        kind (WhoAmIPrimaryCircleKind):
    """

    id: UUID
    slug: str
    name: str
    kind: WhoAmIPrimaryCircleKind
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        slug = self.slug

        name = self.name

        kind = self.kind.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "slug": slug,
                "name": name,
                "kind": kind,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        slug = d.pop("slug")

        name = d.pop("name")

        kind = WhoAmIPrimaryCircleKind(d.pop("kind"))

        who_am_i_primary_circle = cls(
            id=id,
            slug=slug,
            name=name,
            kind=kind,
        )

        who_am_i_primary_circle.additional_properties = d
        return who_am_i_primary_circle

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
