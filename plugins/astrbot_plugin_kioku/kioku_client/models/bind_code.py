from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast
import datetime


T = TypeVar("T", bound="BindCode")


@_attrs_define
class BindCode:
    """
    Attributes:
        code (str):
        expires_at (datetime.datetime):
        expires_in_seconds (int):
    """

    code: str
    expires_at: datetime.datetime
    expires_in_seconds: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        code = self.code

        expires_at = self.expires_at.isoformat()

        expires_in_seconds = self.expires_in_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "expiresAt": expires_at,
                "expiresInSeconds": expires_in_seconds,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        code = d.pop("code")

        expires_at = datetime.datetime.fromisoformat(d.pop("expiresAt"))

        expires_in_seconds = d.pop("expiresInSeconds")

        bind_code = cls(
            code=code,
            expires_at=expires_at,
            expires_in_seconds=expires_in_seconds,
        )

        bind_code.additional_properties = d
        return bind_code

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
