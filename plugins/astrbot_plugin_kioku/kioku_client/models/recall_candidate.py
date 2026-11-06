from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.recall_candidate_layer import RecallCandidateLayer
from ..models.recall_via import RecallVia
from typing import cast


T = TypeVar("T", bound="RecallCandidate")


@_attrs_define
class RecallCandidate:
    """
    Attributes:
        uri (str):
        title (str):
        layer (RecallCandidateLayer):
        priority (int):
        disclosure (None | str):
        score (float):
        via (list[RecallVia]):
        cues (list[str]):
    """

    uri: str
    title: str
    layer: RecallCandidateLayer
    priority: int
    disclosure: None | str
    score: float
    via: list[RecallVia]
    cues: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        title = self.title

        layer = self.layer.value

        priority = self.priority

        disclosure: None | str
        disclosure = self.disclosure

        score = self.score

        via = []
        for via_item_data in self.via:
            via_item = via_item_data.value
            via.append(via_item)

        cues = self.cues

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
                "title": title,
                "layer": layer,
                "priority": priority,
                "disclosure": disclosure,
                "score": score,
                "via": via,
                "cues": cues,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        title = d.pop("title")

        layer = RecallCandidateLayer(d.pop("layer"))

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

        recall_candidate = cls(
            uri=uri,
            title=title,
            layer=layer,
            priority=priority,
            disclosure=disclosure,
            score=score,
            via=via,
            cues=cues,
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
