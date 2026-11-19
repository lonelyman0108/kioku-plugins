from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.boot_entry_kind import BootEntryKind
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="BootEntry")


@_attrs_define
class BootEntry:
    """
    Attributes:
        short_id (str):
        title (str):
        circle_id (UUID):
        circle_slug (None | str):
        kind (BootEntryKind):
        content (str):
    """

    short_id: str
    title: str
    circle_id: UUID
    circle_slug: None | str
    kind: BootEntryKind
    content: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        short_id = self.short_id

        title = self.title

        circle_id = str(self.circle_id)

        circle_slug: None | str
        circle_slug = self.circle_slug

        kind = self.kind.value

        content = self.content

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "shortId": short_id,
                "title": title,
                "circleId": circle_id,
                "circleSlug": circle_slug,
                "kind": kind,
                "content": content,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        short_id = d.pop("shortId")

        title = d.pop("title")

        circle_id = UUID(d.pop("circleId"))

        def _parse_circle_slug(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        circle_slug = _parse_circle_slug(d.pop("circleSlug"))

        kind = BootEntryKind(d.pop("kind"))

        content = d.pop("content")

        boot_entry = cls(
            short_id=short_id,
            title=title,
            circle_id=circle_id,
            circle_slug=circle_slug,
            kind=kind,
            content=content,
        )

        boot_entry.additional_properties = d
        return boot_entry

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
