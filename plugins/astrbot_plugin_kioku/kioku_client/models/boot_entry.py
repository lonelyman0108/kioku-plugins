from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.boot_entry_layer import BootEntryLayer


T = TypeVar("T", bound="BootEntry")


@_attrs_define
class BootEntry:
    """
    Attributes:
        uri (str):
        title (str):
        layer (BootEntryLayer):
        content (str):
    """

    uri: str
    title: str
    layer: BootEntryLayer
    content: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        title = self.title

        layer = self.layer.value

        content = self.content

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
                "title": title,
                "layer": layer,
                "content": content,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        title = d.pop("title")

        layer = BootEntryLayer(d.pop("layer"))

        content = d.pop("content")

        boot_entry = cls(
            uri=uri,
            title=title,
            layer=layer,
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
