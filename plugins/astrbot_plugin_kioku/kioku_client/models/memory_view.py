from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.memory_view_layer import MemoryViewLayer
from ..models.memory_view_provenance import MemoryViewProvenance
from ..models.memory_view_sensitivity import MemoryViewSensitivity
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="MemoryView")


@_attrs_define
class MemoryView:
    """
    Attributes:
        id (UUID):
        uri (str):
        title (str):
        layer (MemoryViewLayer):
        sensitivity (MemoryViewSensitivity):
        provenance (MemoryViewProvenance):
        origin_scope (str):
        content (None | str):
        priority (int):
        disclosure (None | str):
        glossary (list[str]):
        valid_from (str):
        valid_to (None | str):
        version (int):
        created_at (str):
        updated_at (str):
    """

    id: UUID
    uri: str
    title: str
    layer: MemoryViewLayer
    sensitivity: MemoryViewSensitivity
    provenance: MemoryViewProvenance
    origin_scope: str
    content: None | str
    priority: int
    disclosure: None | str
    glossary: list[str]
    valid_from: str
    valid_to: None | str
    version: int
    created_at: str
    updated_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        id = str(self.id)

        uri = self.uri

        title = self.title

        layer = self.layer.value

        sensitivity = self.sensitivity.value

        provenance = self.provenance.value

        origin_scope = self.origin_scope

        content: None | str
        content = self.content

        priority = self.priority

        disclosure: None | str
        disclosure = self.disclosure

        glossary = self.glossary

        valid_from = self.valid_from

        valid_to: None | str
        valid_to = self.valid_to

        version = self.version

        created_at = self.created_at

        updated_at = self.updated_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "uri": uri,
                "title": title,
                "layer": layer,
                "sensitivity": sensitivity,
                "provenance": provenance,
                "originScope": origin_scope,
                "content": content,
                "priority": priority,
                "disclosure": disclosure,
                "glossary": glossary,
                "validFrom": valid_from,
                "validTo": valid_to,
                "version": version,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        id = UUID(d.pop("id"))

        uri = d.pop("uri")

        title = d.pop("title")

        layer = MemoryViewLayer(d.pop("layer"))

        sensitivity = MemoryViewSensitivity(d.pop("sensitivity"))

        provenance = MemoryViewProvenance(d.pop("provenance"))

        origin_scope = d.pop("originScope")

        def _parse_content(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        content = _parse_content(d.pop("content"))

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

        created_at = d.pop("createdAt")

        updated_at = d.pop("updatedAt")

        memory_view = cls(
            id=id,
            uri=uri,
            title=title,
            layer=layer,
            sensitivity=sensitivity,
            provenance=provenance,
            origin_scope=origin_scope,
            content=content,
            priority=priority,
            disclosure=disclosure,
            glossary=glossary,
            valid_from=valid_from,
            valid_to=valid_to,
            version=version,
            created_at=created_at,
            updated_at=updated_at,
        )

        memory_view.additional_properties = d
        return memory_view

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
