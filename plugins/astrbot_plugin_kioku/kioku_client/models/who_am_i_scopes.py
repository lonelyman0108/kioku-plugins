from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.who_am_i_scopes_credentials import WhoAmIScopesCredentials
from ..models.who_am_i_scopes_max_sensitivity import WhoAmIScopesMaxSensitivity
from ..models.who_am_i_scopes_read_kinds_item import WhoAmIScopesReadKindsItem
from ..models.who_am_i_scopes_write_kinds_item import WhoAmIScopesWriteKindsItem
from typing import cast


T = TypeVar("T", bound="WhoAmIScopes")


@_attrs_define
class WhoAmIScopes:
    """
    Attributes:
        read_kinds (list[WhoAmIScopesReadKindsItem]):
        write_kinds (list[WhoAmIScopesWriteKindsItem]):
        max_sensitivity (WhoAmIScopesMaxSensitivity):
        admin (bool):
        allowed_realms (list[str] | None | Unset):
        credentials (WhoAmIScopesCredentials | Unset):  Default: WhoAmIScopesCredentials.NONE.
    """

    read_kinds: list[WhoAmIScopesReadKindsItem]
    write_kinds: list[WhoAmIScopesWriteKindsItem]
    max_sensitivity: WhoAmIScopesMaxSensitivity
    admin: bool
    allowed_realms: list[str] | None | Unset = UNSET
    credentials: WhoAmIScopesCredentials | Unset = WhoAmIScopesCredentials.NONE
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        read_kinds = []
        for read_kinds_item_data in self.read_kinds:
            read_kinds_item = read_kinds_item_data.value
            read_kinds.append(read_kinds_item)

        write_kinds = []
        for write_kinds_item_data in self.write_kinds:
            write_kinds_item = write_kinds_item_data.value
            write_kinds.append(write_kinds_item)

        max_sensitivity = self.max_sensitivity.value

        admin = self.admin

        allowed_realms: list[str] | None | Unset
        if isinstance(self.allowed_realms, Unset):
            allowed_realms = UNSET
        elif isinstance(self.allowed_realms, list):
            allowed_realms = self.allowed_realms

        else:
            allowed_realms = self.allowed_realms

        credentials: str | Unset = UNSET
        if not isinstance(self.credentials, Unset):
            credentials = self.credentials.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "readKinds": read_kinds,
                "writeKinds": write_kinds,
                "maxSensitivity": max_sensitivity,
                "admin": admin,
            }
        )
        if allowed_realms is not UNSET:
            field_dict["allowedRealms"] = allowed_realms
        if credentials is not UNSET:
            field_dict["credentials"] = credentials

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        read_kinds = []
        _read_kinds = d.pop("readKinds")
        for read_kinds_item_data in _read_kinds:
            read_kinds_item = WhoAmIScopesReadKindsItem(read_kinds_item_data)

            read_kinds.append(read_kinds_item)

        write_kinds = []
        _write_kinds = d.pop("writeKinds")
        for write_kinds_item_data in _write_kinds:
            write_kinds_item = WhoAmIScopesWriteKindsItem(write_kinds_item_data)

            write_kinds.append(write_kinds_item)

        max_sensitivity = WhoAmIScopesMaxSensitivity(d.pop("maxSensitivity"))

        admin = d.pop("admin")

        def _parse_allowed_realms(data: object) -> list[str] | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                allowed_realms_type_0 = cast(list[str], data)

                return allowed_realms_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[str] | None | Unset, data)

        allowed_realms = _parse_allowed_realms(d.pop("allowedRealms", UNSET))

        _credentials = d.pop("credentials", UNSET)
        credentials: WhoAmIScopesCredentials | Unset
        if isinstance(_credentials, Unset):
            credentials = UNSET
        else:
            credentials = WhoAmIScopesCredentials(_credentials)

        who_am_i_scopes = cls(
            read_kinds=read_kinds,
            write_kinds=write_kinds,
            max_sensitivity=max_sensitivity,
            admin=admin,
            allowed_realms=allowed_realms,
            credentials=credentials,
        )

        who_am_i_scopes.additional_properties = d
        return who_am_i_scopes

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
