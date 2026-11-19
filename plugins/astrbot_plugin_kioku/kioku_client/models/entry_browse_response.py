from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.entry_browse_response_group_by import EntryBrowseResponseGroupBy
from typing import cast

if TYPE_CHECKING:
    from ..models.entry_browse_group import EntryBrowseGroup


T = TypeVar("T", bound="EntryBrowseResponse")


@_attrs_define
class EntryBrowseResponse:
    """
    Attributes:
        group_by (EntryBrowseResponseGroupBy):
        groups (list[EntryBrowseGroup]):
        truncated (bool):
    """

    group_by: EntryBrowseResponseGroupBy
    groups: list[EntryBrowseGroup]
    truncated: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_browse_group import EntryBrowseGroup  # noqa: PLC0415

        group_by = self.group_by.value

        groups = []
        for groups_item_data in self.groups:
            groups_item = groups_item_data.to_dict()
            groups.append(groups_item)

        truncated = self.truncated

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "groupBy": group_by,
                "groups": groups,
                "truncated": truncated,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_browse_group import EntryBrowseGroup  # noqa: PLC0415

        d = dict(src_dict)
        group_by = EntryBrowseResponseGroupBy(d.pop("groupBy"))

        groups = []
        _groups = d.pop("groups")
        for groups_item_data in _groups:
            groups_item = EntryBrowseGroup.from_dict(groups_item_data)

            groups.append(groups_item)

        truncated = d.pop("truncated")

        entry_browse_response = cls(
            group_by=group_by,
            groups=groups,
            truncated=truncated,
        )

        entry_browse_response.additional_properties = d
        return entry_browse_response

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
