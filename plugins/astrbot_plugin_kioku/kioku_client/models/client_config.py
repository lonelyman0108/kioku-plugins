from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.client_config_elevate_owner_direct import ClientConfigElevateOwnerDirect
from ..models.client_config_person_memory_mode import ClientConfigPersonMemoryMode


T = TypeVar("T", bound="ClientConfig")


@_attrs_define
class ClientConfig:
    """
    Attributes:
        elevate_owner_direct (ClientConfigElevateOwnerDirect | Unset):
        person_memory_mode (ClientConfigPersonMemoryMode | Unset):  Default: ClientConfigPersonMemoryMode.STRICT.
        record_prompt (bool | Unset):
    """

    elevate_owner_direct: ClientConfigElevateOwnerDirect | Unset = UNSET
    person_memory_mode: ClientConfigPersonMemoryMode | Unset = ClientConfigPersonMemoryMode.STRICT
    record_prompt: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        elevate_owner_direct: str | Unset = UNSET
        if not isinstance(self.elevate_owner_direct, Unset):
            elevate_owner_direct = self.elevate_owner_direct.value

        person_memory_mode: str | Unset = UNSET
        if not isinstance(self.person_memory_mode, Unset):
            person_memory_mode = self.person_memory_mode.value

        record_prompt = self.record_prompt

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if elevate_owner_direct is not UNSET:
            field_dict["elevateOwnerDirect"] = elevate_owner_direct
        if person_memory_mode is not UNSET:
            field_dict["personMemoryMode"] = person_memory_mode
        if record_prompt is not UNSET:
            field_dict["recordPrompt"] = record_prompt

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _elevate_owner_direct = d.pop("elevateOwnerDirect", UNSET)
        elevate_owner_direct: ClientConfigElevateOwnerDirect | Unset
        if isinstance(_elevate_owner_direct, Unset):
            elevate_owner_direct = UNSET
        else:
            elevate_owner_direct = ClientConfigElevateOwnerDirect(_elevate_owner_direct)

        _person_memory_mode = d.pop("personMemoryMode", UNSET)
        person_memory_mode: ClientConfigPersonMemoryMode | Unset
        if isinstance(_person_memory_mode, Unset):
            person_memory_mode = UNSET
        else:
            person_memory_mode = ClientConfigPersonMemoryMode(_person_memory_mode)

        record_prompt = d.pop("recordPrompt", UNSET)

        client_config = cls(
            elevate_owner_direct=elevate_owner_direct,
            person_memory_mode=person_memory_mode,
            record_prompt=record_prompt,
        )

        client_config.additional_properties = d
        return client_config

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
