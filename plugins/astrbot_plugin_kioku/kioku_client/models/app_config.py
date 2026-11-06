from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.app_config_elevate_owner_direct import AppConfigElevateOwnerDirect
from ..types import UNSET, Unset


T = TypeVar("T", bound="AppConfig")


@_attrs_define
class AppConfig:
    """
    Attributes:
        elevate_owner_direct (AppConfigElevateOwnerDirect | Unset):
        record_prompt (bool | Unset):
    """

    elevate_owner_direct: AppConfigElevateOwnerDirect | Unset = UNSET
    record_prompt: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        elevate_owner_direct: str | Unset = UNSET
        if not isinstance(self.elevate_owner_direct, Unset):
            elevate_owner_direct = self.elevate_owner_direct.value

        record_prompt = self.record_prompt

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if elevate_owner_direct is not UNSET:
            field_dict["elevateOwnerDirect"] = elevate_owner_direct
        if record_prompt is not UNSET:
            field_dict["recordPrompt"] = record_prompt

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _elevate_owner_direct = d.pop("elevateOwnerDirect", UNSET)
        elevate_owner_direct: AppConfigElevateOwnerDirect | Unset
        if isinstance(_elevate_owner_direct, Unset):
            elevate_owner_direct = UNSET
        else:
            elevate_owner_direct = AppConfigElevateOwnerDirect(_elevate_owner_direct)

        record_prompt = d.pop("recordPrompt", UNSET)

        app_config = cls(
            elevate_owner_direct=elevate_owner_direct,
            record_prompt=record_prompt,
        )

        app_config.additional_properties = d
        return app_config

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
