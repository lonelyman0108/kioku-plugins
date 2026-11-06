from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.subject_facts_role import SubjectFactsRole
from typing import cast

if TYPE_CHECKING:
    from ..models.subject_facts_facts_item import SubjectFactsFactsItem


T = TypeVar("T", bound="SubjectFacts")


@_attrs_define
class SubjectFacts:
    """
    Attributes:
        role (SubjectFactsRole):
        name (None | str):
        facts (list[SubjectFactsFactsItem]):
    """

    role: SubjectFactsRole
    name: None | str
    facts: list[SubjectFactsFactsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.subject_facts_facts_item import SubjectFactsFactsItem  # noqa: PLC0415

        role = self.role.value

        name: None | str
        name = self.name

        facts = []
        for facts_item_data in self.facts:
            facts_item = facts_item_data.to_dict()
            facts.append(facts_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "role": role,
                "name": name,
                "facts": facts,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.subject_facts_facts_item import SubjectFactsFactsItem  # noqa: PLC0415

        d = dict(src_dict)
        role = SubjectFactsRole(d.pop("role"))

        def _parse_name(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        name = _parse_name(d.pop("name"))

        facts = []
        _facts = d.pop("facts")
        for facts_item_data in _facts:
            facts_item = SubjectFactsFactsItem.from_dict(facts_item_data)

            facts.append(facts_item)

        subject_facts = cls(
            role=role,
            name=name,
            facts=facts,
        )

        subject_facts.additional_properties = d
        return subject_facts

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
