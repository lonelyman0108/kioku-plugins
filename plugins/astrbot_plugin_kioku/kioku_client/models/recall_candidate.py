from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.recall_candidate_kind import RecallCandidateKind
from ..models.recall_via import RecallVia
from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.recall_candidate_matched_when import RecallCandidateMatchedWhen


T = TypeVar("T", bound="RecallCandidate")


@_attrs_define
class RecallCandidate:
    """
    Attributes:
        entry_id (UUID):
        short_id (str):
        title (str):
        circle_id (UUID):
        circle_slug (None | str):
        kind (RecallCandidateKind):
        matched_when (RecallCandidateMatchedWhen):
        other_variants_count (int):
        priority (int):
        disclosure (None | str):
        score (float):
        via (list[RecallVia]):
        cues (list[str]):
        cross_group (bool | Unset):
    """

    entry_id: UUID
    short_id: str
    title: str
    circle_id: UUID
    circle_slug: None | str
    kind: RecallCandidateKind
    matched_when: RecallCandidateMatchedWhen
    other_variants_count: int
    priority: int
    disclosure: None | str
    score: float
    via: list[RecallVia]
    cues: list[str]
    cross_group: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.recall_candidate_matched_when import RecallCandidateMatchedWhen  # noqa: PLC0415

        entry_id = str(self.entry_id)

        short_id = self.short_id

        title = self.title

        circle_id = str(self.circle_id)

        circle_slug: None | str
        circle_slug = self.circle_slug

        kind = self.kind.value

        matched_when = self.matched_when.to_dict()

        other_variants_count = self.other_variants_count

        priority = self.priority

        disclosure: None | str
        disclosure = self.disclosure

        score = self.score

        via = []
        for via_item_data in self.via:
            via_item = via_item_data.value
            via.append(via_item)

        cues = self.cues

        cross_group = self.cross_group

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "entryId": entry_id,
                "shortId": short_id,
                "title": title,
                "circleId": circle_id,
                "circleSlug": circle_slug,
                "kind": kind,
                "matchedWhen": matched_when,
                "otherVariantsCount": other_variants_count,
                "priority": priority,
                "disclosure": disclosure,
                "score": score,
                "via": via,
                "cues": cues,
            }
        )
        if cross_group is not UNSET:
            field_dict["crossGroup"] = cross_group

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.recall_candidate_matched_when import RecallCandidateMatchedWhen  # noqa: PLC0415

        d = dict(src_dict)
        entry_id = UUID(d.pop("entryId"))

        short_id = d.pop("shortId")

        title = d.pop("title")

        circle_id = UUID(d.pop("circleId"))

        def _parse_circle_slug(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        circle_slug = _parse_circle_slug(d.pop("circleSlug"))

        kind = RecallCandidateKind(d.pop("kind"))

        matched_when = RecallCandidateMatchedWhen.from_dict(d.pop("matchedWhen"))

        other_variants_count = d.pop("otherVariantsCount")

        priority = d.pop("priority")

        def _parse_disclosure(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        disclosure = _parse_disclosure(d.pop("disclosure"))

        score = d.pop("score")

        via = []
        _via = d.pop("via")
        for via_item_data in _via:
            via_item = RecallVia(via_item_data)

            via.append(via_item)

        cues = cast(list[str], d.pop("cues"))

        cross_group = d.pop("crossGroup", UNSET)

        recall_candidate = cls(
            entry_id=entry_id,
            short_id=short_id,
            title=title,
            circle_id=circle_id,
            circle_slug=circle_slug,
            kind=kind,
            matched_when=matched_when,
            other_variants_count=other_variants_count,
            priority=priority,
            disclosure=disclosure,
            score=score,
            via=via,
            cues=cues,
            cross_group=cross_group,
        )

        recall_candidate.additional_properties = d
        return recall_candidate

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
