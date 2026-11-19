from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.variant_input_when import VariantInputWhen


T = TypeVar("T", bound="VariantInput")


@_attrs_define
class VariantInput:
    """
    Attributes:
        content (str):
        when (VariantInputWhen | Unset):
        sort_order (int | Unset):  Default: 0.
    """

    content: str
    when: VariantInputWhen | Unset = UNSET
    sort_order: int | Unset = 0
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.variant_input_when import VariantInputWhen  # noqa: PLC0415

        content = self.content

        when: dict[str, Any] | Unset = UNSET
        if not isinstance(self.when, Unset):
            when = self.when.to_dict()

        sort_order = self.sort_order

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "content": content,
            }
        )
        if when is not UNSET:
            field_dict["when"] = when
        if sort_order is not UNSET:
            field_dict["sortOrder"] = sort_order

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.variant_input_when import VariantInputWhen  # noqa: PLC0415

        d = dict(src_dict)
        content = d.pop("content")

        _when = d.pop("when", UNSET)
        when: VariantInputWhen | Unset
        if isinstance(_when, Unset):
            when = UNSET
        else:
            when = VariantInputWhen.from_dict(_when)

        sort_order = d.pop("sortOrder", UNSET)

        variant_input = cls(
            content=content,
            when=when,
            sort_order=sort_order,
        )

        variant_input.additional_properties = d
        return variant_input

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
