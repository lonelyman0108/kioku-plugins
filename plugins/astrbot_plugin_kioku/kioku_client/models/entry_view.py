from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.entry_view_kind import EntryViewKind
from ..models.entry_view_provenance import EntryViewProvenance
from ..models.entry_view_sensitivity import EntryViewSensitivity
from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.entry_link_neighbor import EntryLinkNeighbor
    from ..models.entry_variant_view import EntryVariantView
    from ..models.entry_view_other_variants_item import EntryViewOtherVariantsItem


T = TypeVar("T", bound="EntryView")


@_attrs_define
class EntryView:
    """
    Attributes:
        id (UUID):
        short_id (str):
        circle_id (UUID):
        circle_slug (None | str):
        kind (EntryViewKind):
        title (str):
        sensitivity (EntryViewSensitivity):
        provenance (EntryViewProvenance):
        origin_scope (str):
        topics (list[str]):
        realms (list[str]):
        priority (int):
        disclosure (None | str):
        glossary (list[str]):
        valid_from (str):
        valid_to (None | str):
        version (int):
        variants (list[EntryVariantView]):
        created_at (str):
        updated_at (str):
        other_variants (list[EntryViewOtherVariantsItem] | Unset):
        links (list[EntryLinkNeighbor] | Unset):
    """

    id: UUID
    short_id: str
    circle_id: UUID
    circle_slug: None | str
    kind: EntryViewKind
    title: str
    sensitivity: EntryViewSensitivity
    provenance: EntryViewProvenance
    origin_scope: str
    topics: list[str]
    realms: list[str]
    priority: int
    disclosure: None | str
    glossary: list[str]
    valid_from: str
    valid_to: None | str
    version: int
    variants: list[EntryVariantView]
    created_at: str
    updated_at: str
    other_variants: list[EntryViewOtherVariantsItem] | Unset = UNSET
    links: list[EntryLinkNeighbor] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_link_neighbor import EntryLinkNeighbor  # noqa: PLC0415
        from ..models.entry_variant_view import EntryVariantView  # noqa: PLC0415
        from ..models.entry_view_other_variants_item import EntryViewOtherVariantsItem  # noqa: PLC0415

        id = str(self.id)

        short_id = self.short_id

        circle_id = str(self.circle_id)

        circle_slug: None | str
        circle_slug = self.circle_slug

        kind = self.kind.value

        title = self.title

        sensitivity = self.sensitivity.value

        provenance = self.provenance.value

        origin_scope = self.origin_scope

        topics = self.topics

        realms = self.realms

        priority = self.priority

        disclosure: None | str
        disclosure = self.disclosure

        glossary = self.glossary

        valid_from = self.valid_from

        valid_to: None | str
        valid_to = self.valid_to

        version = self.version

        variants = []
        for variants_item_data in self.variants:
            variants_item = variants_item_data.to_dict()
            variants.append(variants_item)

        created_at = self.created_at

        updated_at = self.updated_at

        other_variants: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.other_variants, Unset):
            other_variants = []
            for other_variants_item_data in self.other_variants:
                other_variants_item = other_variants_item_data.to_dict()
                other_variants.append(other_variants_item)

        links: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.links, Unset):
            links = []
            for links_item_data in self.links:
                links_item = links_item_data.to_dict()
                links.append(links_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "shortId": short_id,
                "circleId": circle_id,
                "circleSlug": circle_slug,
                "kind": kind,
                "title": title,
                "sensitivity": sensitivity,
                "provenance": provenance,
                "originScope": origin_scope,
                "topics": topics,
                "realms": realms,
                "priority": priority,
                "disclosure": disclosure,
                "glossary": glossary,
                "validFrom": valid_from,
                "validTo": valid_to,
                "version": version,
                "variants": variants,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
        )
        if other_variants is not UNSET:
            field_dict["otherVariants"] = other_variants
        if links is not UNSET:
            field_dict["links"] = links

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_link_neighbor import EntryLinkNeighbor  # noqa: PLC0415
        from ..models.entry_variant_view import EntryVariantView  # noqa: PLC0415
        from ..models.entry_view_other_variants_item import EntryViewOtherVariantsItem  # noqa: PLC0415

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        short_id = d.pop("shortId")

        circle_id = UUID(d.pop("circleId"))

        def _parse_circle_slug(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        circle_slug = _parse_circle_slug(d.pop("circleSlug"))

        kind = EntryViewKind(d.pop("kind"))

        title = d.pop("title")

        sensitivity = EntryViewSensitivity(d.pop("sensitivity"))

        provenance = EntryViewProvenance(d.pop("provenance"))

        origin_scope = d.pop("originScope")

        topics = cast(list[str], d.pop("topics"))

        realms = cast(list[str], d.pop("realms"))

        priority = d.pop("priority")

        def _parse_disclosure(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        disclosure = _parse_disclosure(d.pop("disclosure"))

        glossary = cast(list[str], d.pop("glossary"))

        valid_from = d.pop("validFrom")

        def _parse_valid_to(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        valid_to = _parse_valid_to(d.pop("validTo"))

        version = d.pop("version")

        variants = []
        _variants = d.pop("variants")
        for variants_item_data in _variants:
            variants_item = EntryVariantView.from_dict(variants_item_data)

            variants.append(variants_item)

        created_at = d.pop("createdAt")

        updated_at = d.pop("updatedAt")

        _other_variants = d.pop("otherVariants", UNSET)
        other_variants: list[EntryViewOtherVariantsItem] | Unset = UNSET
        if _other_variants is not UNSET:
            other_variants = []
            for other_variants_item_data in _other_variants:
                other_variants_item = EntryViewOtherVariantsItem.from_dict(other_variants_item_data)

                other_variants.append(other_variants_item)

        _links = d.pop("links", UNSET)
        links: list[EntryLinkNeighbor] | Unset = UNSET
        if _links is not UNSET:
            links = []
            for links_item_data in _links:
                links_item = EntryLinkNeighbor.from_dict(links_item_data)

                links.append(links_item)

        entry_view = cls(
            id=id,
            short_id=short_id,
            circle_id=circle_id,
            circle_slug=circle_slug,
            kind=kind,
            title=title,
            sensitivity=sensitivity,
            provenance=provenance,
            origin_scope=origin_scope,
            topics=topics,
            realms=realms,
            priority=priority,
            disclosure=disclosure,
            glossary=glossary,
            valid_from=valid_from,
            valid_to=valid_to,
            version=version,
            variants=variants,
            created_at=created_at,
            updated_at=updated_at,
            other_variants=other_variants,
            links=links,
        )

        entry_view.additional_properties = d
        return entry_view

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
