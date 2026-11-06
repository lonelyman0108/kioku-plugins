from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.memory_summary_layer_type_1 import MemorySummaryLayerType1
from ..models.memory_summary_layer_type_2_type_1 import MemorySummaryLayerType2Type1
from ..models.memory_summary_layer_type_3_type_1 import MemorySummaryLayerType3Type1
from ..models.memory_summary_sensitivity_type_1 import MemorySummarySensitivityType1
from ..models.memory_summary_sensitivity_type_2_type_1 import MemorySummarySensitivityType2Type1
from ..models.memory_summary_sensitivity_type_3_type_1 import MemorySummarySensitivityType3Type1
from typing import cast
from uuid import UUID


T = TypeVar("T", bound="MemorySummary")


@_attrs_define
class MemorySummary:
    """
    Attributes:
        uri (str):
        exists (bool):
        id (None | UUID):
        title (None | str):
        layer (MemorySummaryLayerType1 | MemorySummaryLayerType2Type1 | MemorySummaryLayerType3Type1 | None):
        sensitivity (MemorySummarySensitivityType1 | MemorySummarySensitivityType2Type1 |
            MemorySummarySensitivityType3Type1 | None):
        priority (int | None):
        disclosure (None | str):
        child_count (int):
    """

    uri: str
    exists: bool
    id: None | UUID
    title: None | str
    layer: (
        MemorySummaryLayerType1 | MemorySummaryLayerType2Type1 | MemorySummaryLayerType3Type1 | None
    )
    sensitivity: (
        MemorySummarySensitivityType1
        | MemorySummarySensitivityType2Type1
        | MemorySummarySensitivityType3Type1
        | None
    )
    priority: int | None
    disclosure: None | str
    child_count: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        exists = self.exists

        id: None | str
        if isinstance(self.id, UUID):
            id = str(self.id)
        else:
            id = self.id

        title: None | str
        title = self.title

        layer: None | str
        if isinstance(self.layer, MemorySummaryLayerType1):
            layer = self.layer.value
        elif isinstance(self.layer, MemorySummaryLayerType2Type1):
            layer = self.layer.value
        elif isinstance(self.layer, MemorySummaryLayerType3Type1):
            layer = self.layer.value
        else:
            layer = self.layer

        sensitivity: None | str
        if isinstance(self.sensitivity, MemorySummarySensitivityType1):
            sensitivity = self.sensitivity.value
        elif isinstance(self.sensitivity, MemorySummarySensitivityType2Type1):
            sensitivity = self.sensitivity.value
        elif isinstance(self.sensitivity, MemorySummarySensitivityType3Type1):
            sensitivity = self.sensitivity.value
        else:
            sensitivity = self.sensitivity

        priority: int | None
        priority = self.priority

        disclosure: None | str
        disclosure = self.disclosure

        child_count = self.child_count

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
                "exists": exists,
                "id": id,
                "title": title,
                "layer": layer,
                "sensitivity": sensitivity,
                "priority": priority,
                "disclosure": disclosure,
                "childCount": child_count,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        exists = d.pop("exists")

        def _parse_id(data: object) -> None | UUID:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                id_type_0 = UUID(data)

                return id_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | UUID, data)

        id = _parse_id(d.pop("id"))

        def _parse_title(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        title = _parse_title(d.pop("title"))

        def _parse_layer(
            data: object,
        ) -> (
            MemorySummaryLayerType1
            | MemorySummaryLayerType2Type1
            | MemorySummaryLayerType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                layer_type_1 = MemorySummaryLayerType1(data)

                return layer_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                layer_type_2_type_1 = MemorySummaryLayerType2Type1(data)

                return layer_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                layer_type_3_type_1 = MemorySummaryLayerType3Type1(data)

                return layer_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MemorySummaryLayerType1
                | MemorySummaryLayerType2Type1
                | MemorySummaryLayerType3Type1
                | None,
                data,
            )

        layer = _parse_layer(d.pop("layer"))

        def _parse_sensitivity(
            data: object,
        ) -> (
            MemorySummarySensitivityType1
            | MemorySummarySensitivityType2Type1
            | MemorySummarySensitivityType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                sensitivity_type_1 = MemorySummarySensitivityType1(data)

                return sensitivity_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                sensitivity_type_2_type_1 = MemorySummarySensitivityType2Type1(data)

                return sensitivity_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                sensitivity_type_3_type_1 = MemorySummarySensitivityType3Type1(data)

                return sensitivity_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                MemorySummarySensitivityType1
                | MemorySummarySensitivityType2Type1
                | MemorySummarySensitivityType3Type1
                | None,
                data,
            )

        sensitivity = _parse_sensitivity(d.pop("sensitivity"))

        def _parse_priority(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        priority = _parse_priority(d.pop("priority"))

        def _parse_disclosure(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        disclosure = _parse_disclosure(d.pop("disclosure"))

        child_count = d.pop("childCount")

        memory_summary = cls(
            uri=uri,
            exists=exists,
            id=id,
            title=title,
            layer=layer,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            child_count=child_count,
        )

        memory_summary.additional_properties = d
        return memory_summary

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
