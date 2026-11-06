from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.who_am_i_scopes_max_sensitivity import WhoAmIScopesMaxSensitivity
from ..models.who_am_i_scopes_read_layers_item import WhoAmIScopesReadLayersItem
from ..models.who_am_i_scopes_write_layers_item import WhoAmIScopesWriteLayersItem
from typing import cast


T = TypeVar("T", bound="WhoAmIScopes")


@_attrs_define
class WhoAmIScopes:
    """
    Attributes:
        read_layers (list[WhoAmIScopesReadLayersItem]):
        write_layers (list[WhoAmIScopesWriteLayersItem]):
        max_sensitivity (WhoAmIScopesMaxSensitivity):
        admin (bool):
    """

    read_layers: list[WhoAmIScopesReadLayersItem]
    write_layers: list[WhoAmIScopesWriteLayersItem]
    max_sensitivity: WhoAmIScopesMaxSensitivity
    admin: bool
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        read_layers = []
        for read_layers_item_data in self.read_layers:
            read_layers_item = read_layers_item_data.value
            read_layers.append(read_layers_item)

        write_layers = []
        for write_layers_item_data in self.write_layers:
            write_layers_item = write_layers_item_data.value
            write_layers.append(write_layers_item)

        max_sensitivity = self.max_sensitivity.value

        admin = self.admin

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "readLayers": read_layers,
                "writeLayers": write_layers,
                "maxSensitivity": max_sensitivity,
                "admin": admin,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        read_layers = []
        _read_layers = d.pop("readLayers")
        for read_layers_item_data in _read_layers:
            read_layers_item = WhoAmIScopesReadLayersItem(read_layers_item_data)

            read_layers.append(read_layers_item)

        write_layers = []
        _write_layers = d.pop("writeLayers")
        for write_layers_item_data in _write_layers:
            write_layers_item = WhoAmIScopesWriteLayersItem(write_layers_item_data)

            write_layers.append(write_layers_item)

        max_sensitivity = WhoAmIScopesMaxSensitivity(d.pop("maxSensitivity"))

        admin = d.pop("admin")

        who_am_i_scopes = cls(
            read_layers=read_layers,
            write_layers=write_layers,
            max_sensitivity=max_sensitivity,
            admin=admin,
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
