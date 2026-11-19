from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.entry_browse_item import EntryBrowseItem


T = TypeVar("T", bound="EntryBrowseGroup")


@_attrs_define
class EntryBrowseGroup:
    """
    Attributes:
        key (str):
        label (str):
        count (int):
        items (list[EntryBrowseItem]):
    """

    key: str
    label: str
    count: int
    items: list[EntryBrowseItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_browse_item import EntryBrowseItem  # noqa: PLC0415

        key = self.key

        label = self.label

        count = self.count

        items = []
        for items_item_data in self.items:
            items_item = items_item_data.to_dict()
            items.append(items_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "key": key,
                "label": label,
                "count": count,
                "items": items,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_browse_item import EntryBrowseItem  # noqa: PLC0415

        d = dict(src_dict)
        key = d.pop("key")

        label = d.pop("label")

        count = d.pop("count")

        items = []
        _items = d.pop("items")
        for items_item_data in _items:
            items_item = EntryBrowseItem.from_dict(items_item_data)

            items.append(items_item)

        entry_browse_group = cls(
            key=key,
            label=label,
            count=count,
            items=items,
        )

        entry_browse_group.additional_properties = d
        return entry_browse_group

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
