from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.who_am_i_linked_circles_item_kind import WhoAmILinkedCirclesItemKind
from ..models.who_am_i_linked_circles_item_mode import WhoAmILinkedCirclesItemMode
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="WhoAmILinkedCirclesItem")


@_attrs_define
class WhoAmILinkedCirclesItem:
    """
    Attributes:
        id (UUID):
        slug (None | str):
        name (None | str):
        kind (WhoAmILinkedCirclesItemKind):
        mode (WhoAmILinkedCirclesItemMode):
    """

    id: UUID
    slug: None | str
    name: None | str
    kind: WhoAmILinkedCirclesItemKind
    mode: WhoAmILinkedCirclesItemMode
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        slug: None | str
        slug = self.slug

        name: None | str
        name = self.name

        kind = self.kind.value

        mode = self.mode.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "slug": slug,
                "name": name,
                "kind": kind,
                "mode": mode,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        def _parse_slug(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        slug = _parse_slug(d.pop("slug"))

        def _parse_name(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        name = _parse_name(d.pop("name"))

        kind = WhoAmILinkedCirclesItemKind(d.pop("kind"))

        mode = WhoAmILinkedCirclesItemMode(d.pop("mode"))

        who_am_i_linked_circles_item = cls(
            id=id,
            slug=slug,
            name=name,
            kind=kind,
            mode=mode,
        )

        who_am_i_linked_circles_item.additional_properties = d
        return who_am_i_linked_circles_item

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
