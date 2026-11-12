from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from uuid import UUID


T = TypeVar("T", bound="MoveMemoryRequest")


@_attrs_define
class MoveMemoryRequest:
    """
    Attributes:
        from_ (str):
        to (str):
        expected_id (UUID | Unset):
        expected_version (int | Unset):
    """

    from_: str
    to: str
    expected_id: UUID | Unset = UNSET
    expected_version: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from_ = self.from_

        to = self.to

        expected_id: str | Unset = UNSET
        if not isinstance(self.expected_id, Unset):
            expected_id = str(self.expected_id)

        expected_version = self.expected_version

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "from": from_,
                "to": to,
            }
        )
        if expected_id is not UNSET:
            field_dict["expectedId"] = expected_id
        if expected_version is not UNSET:
            field_dict["expectedVersion"] = expected_version

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        from_ = d.pop("from")

        to = d.pop("to")

        _expected_id = d.pop("expectedId", UNSET)
        expected_id: UUID | Unset
        if isinstance(_expected_id, Unset):
            expected_id = UNSET
        else:
            expected_id = UUID(_expected_id)

        expected_version = d.pop("expectedVersion", UNSET)

        move_memory_request = cls(
            from_=from_,
            to=to,
            expected_id=expected_id,
            expected_version=expected_version,
        )

        move_memory_request.additional_properties = d
        return move_memory_request

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
