from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset


T = TypeVar("T", bound="BootResponsePersonaTraitsItem")


@_attrs_define
class BootResponsePersonaTraitsItem:
    """
    Attributes:
        trait_key (str):
        title (str):
        content (str):
    """

    trait_key: str
    title: str
    content: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        trait_key = self.trait_key

        title = self.title

        content = self.content

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "traitKey": trait_key,
                "title": title,
                "content": content,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        trait_key = d.pop("traitKey")

        title = d.pop("title")

        content = d.pop("content")

        boot_response_persona_traits_item = cls(
            trait_key=trait_key,
            title=title,
            content=content,
        )

        boot_response_persona_traits_item.additional_properties = d
        return boot_response_persona_traits_item

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
