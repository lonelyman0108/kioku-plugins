from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.entry_link_neighbor_direction import EntryLinkNeighborDirection
from ..models.entry_link_neighbor_kind import EntryLinkNeighborKind
from ..models.entry_link_neighbor_sensitivity import EntryLinkNeighborSensitivity
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="EntryLinkNeighbor")


@_attrs_define
class EntryLinkNeighbor:
    """
    Attributes:
        short_id (str):
        title (str):
        circle_id (UUID):
        circle_slug (str):
        kind (EntryLinkNeighborKind):
        sensitivity (EntryLinkNeighborSensitivity):
        direction (EntryLinkNeighborDirection):
        source_variant_id (None | UUID):
    """

    short_id: str
    title: str
    circle_id: UUID
    circle_slug: str
    kind: EntryLinkNeighborKind
    sensitivity: EntryLinkNeighborSensitivity
    direction: EntryLinkNeighborDirection
    source_variant_id: None | UUID
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        short_id = self.short_id

        title = self.title

        circle_id = str(self.circle_id)

        circle_slug = self.circle_slug

        kind = self.kind.value

        sensitivity = self.sensitivity.value

        direction = self.direction.value

        source_variant_id: None | str
        if isinstance(self.source_variant_id, UUID):
            source_variant_id = str(self.source_variant_id)
        else:
            source_variant_id = self.source_variant_id

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "shortId": short_id,
                "title": title,
                "circleId": circle_id,
                "circleSlug": circle_slug,
                "kind": kind,
                "sensitivity": sensitivity,
                "direction": direction,
                "sourceVariantId": source_variant_id,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        short_id = d.pop("shortId")

        title = d.pop("title")

        circle_id = UUID(d.pop("circleId"))

        circle_slug = d.pop("circleSlug")

        kind = EntryLinkNeighborKind(d.pop("kind"))

        sensitivity = EntryLinkNeighborSensitivity(d.pop("sensitivity"))

        direction = EntryLinkNeighborDirection(d.pop("direction"))

        def _parse_source_variant_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                source_variant_id_type_0 = UUID(data)

                return source_variant_id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        source_variant_id = _parse_source_variant_id(d.pop("sourceVariantId"))

        entry_link_neighbor = cls(
            short_id=short_id,
            title=title,
            circle_id=circle_id,
            circle_slug=circle_slug,
            kind=kind,
            sensitivity=sensitivity,
            direction=direction,
            source_variant_id=source_variant_id,
        )

        entry_link_neighbor.additional_properties = d
        return entry_link_neighbor

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
