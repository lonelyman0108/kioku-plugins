from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.boot_entry import BootEntry
    from ..models.boot_response_persona_traits_item import BootResponsePersonaTraitsItem


T = TypeVar("T", bound="BootResponse")


@_attrs_define
class BootResponse:
    """
    Attributes:
        entries (list[BootEntry]):
        omitted (list[str]):
        persona_traits (list[BootResponsePersonaTraitsItem] | Unset):
    """

    entries: list[BootEntry]
    omitted: list[str]
    persona_traits: list[BootResponsePersonaTraitsItem] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.boot_entry import BootEntry  # noqa: PLC0415
        from ..models.boot_response_persona_traits_item import BootResponsePersonaTraitsItem  # noqa: PLC0415

        entries = []
        for entries_item_data in self.entries:
            entries_item = entries_item_data.to_dict()
            entries.append(entries_item)

        omitted = self.omitted

        persona_traits: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.persona_traits, Unset):
            persona_traits = []
            for persona_traits_item_data in self.persona_traits:
                persona_traits_item = persona_traits_item_data.to_dict()
                persona_traits.append(persona_traits_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "entries": entries,
                "omitted": omitted,
            }
        )
        if persona_traits is not UNSET:
            field_dict["personaTraits"] = persona_traits

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.boot_entry import BootEntry  # noqa: PLC0415
        from ..models.boot_response_persona_traits_item import BootResponsePersonaTraitsItem  # noqa: PLC0415

        d = dict(src_dict)
        entries = []
        _entries = d.pop("entries")
        for entries_item_data in _entries:
            entries_item = BootEntry.from_dict(entries_item_data)

            entries.append(entries_item)

        omitted = cast(list[str], d.pop("omitted"))

        _persona_traits = d.pop("personaTraits", UNSET)
        persona_traits: list[BootResponsePersonaTraitsItem] | Unset = UNSET
        if _persona_traits is not UNSET:
            persona_traits = []
            for persona_traits_item_data in _persona_traits:
                persona_traits_item = BootResponsePersonaTraitsItem.from_dict(
                    persona_traits_item_data
                )

                persona_traits.append(persona_traits_item)

        boot_response = cls(
            entries=entries,
            omitted=omitted,
            persona_traits=persona_traits,
        )

        boot_response.additional_properties = d
        return boot_response

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
