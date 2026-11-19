from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.entry_view_other_variants_item_when import EntryViewOtherVariantsItemWhen


T = TypeVar("T", bound="EntryViewOtherVariantsItem")


@_attrs_define
class EntryViewOtherVariantsItem:
    """
    Attributes:
        when (EntryViewOtherVariantsItemWhen):
        when_signature (str):
    """

    when: EntryViewOtherVariantsItemWhen
    when_signature: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_view_other_variants_item_when import EntryViewOtherVariantsItemWhen  # noqa: PLC0415

        when = self.when.to_dict()

        when_signature = self.when_signature

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "when": when,
                "whenSignature": when_signature,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_view_other_variants_item_when import EntryViewOtherVariantsItemWhen  # noqa: PLC0415

        d = dict(src_dict)
        when = EntryViewOtherVariantsItemWhen.from_dict(d.pop("when"))

        when_signature = d.pop("whenSignature")

        entry_view_other_variants_item = cls(
            when=when,
            when_signature=when_signature,
        )

        entry_view_other_variants_item.additional_properties = d
        return entry_view_other_variants_item

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
