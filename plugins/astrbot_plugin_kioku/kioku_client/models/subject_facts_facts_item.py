from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset


T = TypeVar("T", bound="SubjectFactsFactsItem")


@_attrs_define
class SubjectFactsFactsItem:
    """
    Attributes:
        content (str):
        updated_at (str):
        short_id (str | Unset):
        cross_group (bool | Unset):
    """

    content: str
    updated_at: str
    short_id: str | Unset = UNSET
    cross_group: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        content = self.content

        updated_at = self.updated_at

        short_id = self.short_id

        cross_group = self.cross_group

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "content": content,
                "updatedAt": updated_at,
            }
        )
        if short_id is not UNSET:
            field_dict["shortId"] = short_id
        if cross_group is not UNSET:
            field_dict["crossGroup"] = cross_group

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        content = d.pop("content")

        updated_at = d.pop("updatedAt")

        short_id = d.pop("shortId", UNSET)

        cross_group = d.pop("crossGroup", UNSET)

        subject_facts_facts_item = cls(
            content=content,
            updated_at=updated_at,
            short_id=short_id,
            cross_group=cross_group,
        )

        subject_facts_facts_item.additional_properties = d
        return subject_facts_facts_item

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
