from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.recall_candidate import RecallCandidate
    from ..models.subject_facts import SubjectFacts


T = TypeVar("T", bound="RecallResponse")


@_attrs_define
class RecallResponse:
    """
    Attributes:
        candidates (list[RecallCandidate]):
        subjects (list[SubjectFacts]):
    """

    candidates: list[RecallCandidate]
    subjects: list[SubjectFacts]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.recall_candidate import RecallCandidate  # noqa: PLC0415
        from ..models.subject_facts import SubjectFacts  # noqa: PLC0415

        candidates = []
        for candidates_item_data in self.candidates:
            candidates_item = candidates_item_data.to_dict()
            candidates.append(candidates_item)

        subjects = []
        for subjects_item_data in self.subjects:
            subjects_item = subjects_item_data.to_dict()
            subjects.append(subjects_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "candidates": candidates,
                "subjects": subjects,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.recall_candidate import RecallCandidate  # noqa: PLC0415
        from ..models.subject_facts import SubjectFacts  # noqa: PLC0415

        d = dict(src_dict)
        candidates = []
        _candidates = d.pop("candidates")
        for candidates_item_data in _candidates:
            candidates_item = RecallCandidate.from_dict(candidates_item_data)

            candidates.append(candidates_item)

        subjects = []
        _subjects = d.pop("subjects")
        for subjects_item_data in _subjects:
            subjects_item = SubjectFacts.from_dict(subjects_item_data)

            subjects.append(subjects_item)

        recall_response = cls(
            candidates=candidates,
            subjects=subjects,
        )

        recall_response.additional_properties = d
        return recall_response

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
