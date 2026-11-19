from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset


T = TypeVar("T", bound="TransferEntryRequest")


@_attrs_define
class TransferEntryRequest:
    """
    Attributes:
        id (str):
        to_circle (str):
        from_circle (str | Unset):
        expected_version (int | Unset):
    """

    id: str
    to_circle: str
    from_circle: str | Unset = UNSET
    expected_version: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = self.id

        to_circle = self.to_circle

        from_circle = self.from_circle

        expected_version = self.expected_version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "toCircle": to_circle,
            }
        )
        if from_circle is not UNSET:
            field_dict["fromCircle"] = from_circle
        if expected_version is not UNSET:
            field_dict["expectedVersion"] = expected_version

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = d.pop("id")

        to_circle = d.pop("toCircle")

        from_circle = d.pop("fromCircle", UNSET)

        expected_version = d.pop("expectedVersion", UNSET)

        transfer_entry_request = cls(
            id=id,
            to_circle=to_circle,
            from_circle=from_circle,
            expected_version=expected_version,
        )

        transfer_entry_request.additional_properties = d
        return transfer_entry_request

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
