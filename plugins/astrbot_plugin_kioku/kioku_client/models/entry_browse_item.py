from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.entry_browse_item_kind import EntryBrowseItemKind
from ..models.entry_browse_item_sensitivity import EntryBrowseItemSensitivity
from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.entry_browse_item_variants_summary_item import EntryBrowseItemVariantsSummaryItem


T = TypeVar("T", bound="EntryBrowseItem")


@_attrs_define
class EntryBrowseItem:
    """
    Attributes:
        id (UUID):
        short_id (str):
        title (str):
        circle_id (UUID):
        circle_slug (None | str):
        kind (EntryBrowseItemKind):
        sensitivity (EntryBrowseItemSensitivity):
        priority (int):
        topics (list[str]):
        disclosure (None | str):
        variant_count (int):
        variants_summary (list[EntryBrowseItemVariantsSummaryItem]):
    """

    id: UUID
    short_id: str
    title: str
    circle_id: UUID
    circle_slug: None | str
    kind: EntryBrowseItemKind
    sensitivity: EntryBrowseItemSensitivity
    priority: int
    topics: list[str]
    disclosure: None | str
    variant_count: int
    variants_summary: list[EntryBrowseItemVariantsSummaryItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_browse_item_variants_summary_item import (
            EntryBrowseItemVariantsSummaryItem,
        )  # noqa: PLC0415

        id = str(self.id)

        short_id = self.short_id

        title = self.title

        circle_id = str(self.circle_id)

        circle_slug: None | str
        circle_slug = self.circle_slug

        kind = self.kind.value

        sensitivity = self.sensitivity.value

        priority = self.priority

        topics = self.topics

        disclosure: None | str
        disclosure = self.disclosure

        variant_count = self.variant_count

        variants_summary = []
        for variants_summary_item_data in self.variants_summary:
            variants_summary_item = variants_summary_item_data.to_dict()
            variants_summary.append(variants_summary_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "shortId": short_id,
                "title": title,
                "circleId": circle_id,
                "circleSlug": circle_slug,
                "kind": kind,
                "sensitivity": sensitivity,
                "priority": priority,
                "topics": topics,
                "disclosure": disclosure,
                "variantCount": variant_count,
                "variantsSummary": variants_summary,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_browse_item_variants_summary_item import (
            EntryBrowseItemVariantsSummaryItem,
        )  # noqa: PLC0415

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        short_id = d.pop("shortId")

        title = d.pop("title")

        circle_id = UUID(d.pop("circleId"))

        def _parse_circle_slug(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        circle_slug = _parse_circle_slug(d.pop("circleSlug"))

        kind = EntryBrowseItemKind(d.pop("kind"))

        sensitivity = EntryBrowseItemSensitivity(d.pop("sensitivity"))

        priority = d.pop("priority")

        topics = cast(list[str], d.pop("topics"))

        def _parse_disclosure(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        disclosure = _parse_disclosure(d.pop("disclosure"))

        variant_count = d.pop("variantCount")

        variants_summary = []
        _variants_summary = d.pop("variantsSummary")
        for variants_summary_item_data in _variants_summary:
            variants_summary_item = EntryBrowseItemVariantsSummaryItem.from_dict(
                variants_summary_item_data
            )

            variants_summary.append(variants_summary_item)

        entry_browse_item = cls(
            id=id,
            short_id=short_id,
            title=title,
            circle_id=circle_id,
            circle_slug=circle_slug,
            kind=kind,
            sensitivity=sensitivity,
            priority=priority,
            topics=topics,
            disclosure=disclosure,
            variant_count=variant_count,
            variants_summary=variants_summary,
        )

        entry_browse_item.additional_properties = d
        return entry_browse_item

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
