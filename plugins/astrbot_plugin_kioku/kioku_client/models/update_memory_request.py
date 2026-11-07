from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.update_memory_request_sensitivity import UpdateMemoryRequestSensitivity
from ..types import UNSET, Unset
from typing import cast
from uuid import UUID
import datetime


T = TypeVar("T", bound="UpdateMemoryRequest")


@_attrs_define
class UpdateMemoryRequest:
    """
    Attributes:
        uri (str):
        expected_version (int | Unset):
        expected_id (UUID | Unset):
        title (str | Unset):
        content (str | Unset):
        sensitivity (UpdateMemoryRequestSensitivity | Unset):
        priority (int | Unset):
        disclosure (None | str | Unset):
        glossary_add (list[str] | Unset):
        glossary_remove (list[str] | Unset):
        valid_to (datetime.datetime | None | Unset): 有效到：ISO 8601 的时间，要带时区（例如 2026-12-31T23:59:00+08:00 或
            2026-12-31T15:59:00Z），不带时区的会被拒绝；要比现在晚至少一分钟。到期后不再召回、不进 boot；填 null 清掉，一直有效
        plaintext_ok (bool | Unset): 正文里新增的疑似明文确实不是凭据时设为 true：照常写入，这条记忆进待处理。是凭据时先存成凭据，正文写占位符
    """

    uri: str
    expected_version: int | Unset = UNSET
    expected_id: UUID | Unset = UNSET
    title: str | Unset = UNSET
    content: str | Unset = UNSET
    sensitivity: UpdateMemoryRequestSensitivity | Unset = UNSET
    priority: int | Unset = UNSET
    disclosure: None | str | Unset = UNSET
    glossary_add: list[str] | Unset = UNSET
    glossary_remove: list[str] | Unset = UNSET
    valid_to: datetime.datetime | None | Unset = UNSET
    plaintext_ok: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        uri = self.uri

        expected_version = self.expected_version

        expected_id: str | Unset = UNSET
        if not isinstance(self.expected_id, Unset):
            expected_id = str(self.expected_id)

        title = self.title

        content = self.content

        sensitivity: str | Unset = UNSET
        if not isinstance(self.sensitivity, Unset):
            sensitivity = self.sensitivity.value

        priority = self.priority

        disclosure: None | str | Unset
        if isinstance(self.disclosure, Unset):
            disclosure = UNSET
        else:
            disclosure = self.disclosure

        glossary_add: list[str] | Unset = UNSET
        if not isinstance(self.glossary_add, Unset):
            glossary_add = self.glossary_add

        glossary_remove: list[str] | Unset = UNSET
        if not isinstance(self.glossary_remove, Unset):
            glossary_remove = self.glossary_remove

        valid_to: None | str | Unset
        if isinstance(self.valid_to, Unset):
            valid_to = UNSET
        elif isinstance(self.valid_to, datetime.datetime):
            valid_to = self.valid_to.isoformat()
        else:
            valid_to = self.valid_to

        plaintext_ok = self.plaintext_ok

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "uri": uri,
            }
        )
        if expected_version is not UNSET:
            field_dict["expectedVersion"] = expected_version
        if expected_id is not UNSET:
            field_dict["expectedId"] = expected_id
        if title is not UNSET:
            field_dict["title"] = title
        if content is not UNSET:
            field_dict["content"] = content
        if sensitivity is not UNSET:
            field_dict["sensitivity"] = sensitivity
        if priority is not UNSET:
            field_dict["priority"] = priority
        if disclosure is not UNSET:
            field_dict["disclosure"] = disclosure
        if glossary_add is not UNSET:
            field_dict["glossaryAdd"] = glossary_add
        if glossary_remove is not UNSET:
            field_dict["glossaryRemove"] = glossary_remove
        if valid_to is not UNSET:
            field_dict["validTo"] = valid_to
        if plaintext_ok is not UNSET:
            field_dict["plaintextOk"] = plaintext_ok

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        uri = d.pop("uri")

        expected_version = d.pop("expectedVersion", UNSET)

        _expected_id = d.pop("expectedId", UNSET)
        expected_id: UUID | Unset
        if isinstance(_expected_id, Unset):
            expected_id = UNSET
        else:
            expected_id = UUID(_expected_id)

        title = d.pop("title", UNSET)

        content = d.pop("content", UNSET)

        _sensitivity = d.pop("sensitivity", UNSET)
        sensitivity: UpdateMemoryRequestSensitivity | Unset
        if isinstance(_sensitivity, Unset):
            sensitivity = UNSET
        else:
            sensitivity = UpdateMemoryRequestSensitivity(_sensitivity)

        priority = d.pop("priority", UNSET)

        def _parse_disclosure(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        disclosure = _parse_disclosure(d.pop("disclosure", UNSET))

        glossary_add = cast(list[str], d.pop("glossaryAdd", UNSET))

        glossary_remove = cast(list[str], d.pop("glossaryRemove", UNSET))

        def _parse_valid_to(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                valid_to_type_0 = datetime.datetime.fromisoformat(data)

                return valid_to_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        valid_to = _parse_valid_to(d.pop("validTo", UNSET))

        plaintext_ok = d.pop("plaintextOk", UNSET)

        update_memory_request = cls(
            uri=uri,
            expected_version=expected_version,
            expected_id=expected_id,
            title=title,
            content=content,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            glossary_add=glossary_add,
            glossary_remove=glossary_remove,
            valid_to=valid_to,
            plaintext_ok=plaintext_ok,
        )

        update_memory_request.additional_properties = d
        return update_memory_request

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
