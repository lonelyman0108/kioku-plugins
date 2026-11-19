from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.create_entry_request_sensitivity import CreateEntryRequestSensitivity
from typing import cast
import datetime

if TYPE_CHECKING:
    from ..models.create_entry_request_when import CreateEntryRequestWhen
    from ..models.variant_input import VariantInput


T = TypeVar("T", bound="CreateEntryRequest")


@_attrs_define
class CreateEntryRequest:
    """
    Attributes:
        circle (str | Unset):
        title (str | Unset):
        content (str | Unset):
        when (CreateEntryRequestWhen | Unset):
        variants (list[VariantInput] | Unset):
        topics (list[str] | Unset):
        sensitivity (CreateEntryRequestSensitivity | Unset):
        priority (int | Unset):  Default: 2.
        disclosure (str | Unset):
        glossary (list[str] | Unset):
        valid_to (datetime.datetime | Unset): 有效到：ISO 8601 的时间，要带时区（例如 2026-12-31T23:59:00+08:00 或
            2026-12-31T15:59:00Z），不带时区的会被拒绝；要比现在晚至少一分钟。到期后不再召回、不进 boot；不填就一直有效
        plaintext_ok (bool | Unset): 正文里新增的疑似明文确实不是凭据时设为 true：照常写入，这条词条进待处理。是凭据时先存成凭据，正文写占位符
    """

    circle: str | Unset = UNSET
    title: str | Unset = UNSET
    content: str | Unset = UNSET
    when: CreateEntryRequestWhen | Unset = UNSET
    variants: list[VariantInput] | Unset = UNSET
    topics: list[str] | Unset = UNSET
    sensitivity: CreateEntryRequestSensitivity | Unset = UNSET
    priority: int | Unset = 2
    disclosure: str | Unset = UNSET
    glossary: list[str] | Unset = UNSET
    valid_to: datetime.datetime | Unset = UNSET
    plaintext_ok: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.create_entry_request_when import CreateEntryRequestWhen  # noqa: PLC0415
        from ..models.variant_input import VariantInput  # noqa: PLC0415

        circle = self.circle

        title = self.title

        content = self.content

        when: dict[str, Any] | Unset = UNSET
        if not isinstance(self.when, Unset):
            when = self.when.to_dict()

        variants: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.variants, Unset):
            variants = []
            for variants_item_data in self.variants:
                variants_item = variants_item_data.to_dict()
                variants.append(variants_item)

        topics: list[str] | Unset = UNSET
        if not isinstance(self.topics, Unset):
            topics = self.topics

        sensitivity: str | Unset = UNSET
        if not isinstance(self.sensitivity, Unset):
            sensitivity = self.sensitivity.value

        priority = self.priority

        disclosure = self.disclosure

        glossary: list[str] | Unset = UNSET
        if not isinstance(self.glossary, Unset):
            glossary = self.glossary

        valid_to: str | Unset = UNSET
        if not isinstance(self.valid_to, Unset):
            valid_to = self.valid_to.isoformat()

        plaintext_ok = self.plaintext_ok

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if circle is not UNSET:
            field_dict["circle"] = circle
        if title is not UNSET:
            field_dict["title"] = title
        if content is not UNSET:
            field_dict["content"] = content
        if when is not UNSET:
            field_dict["when"] = when
        if variants is not UNSET:
            field_dict["variants"] = variants
        if topics is not UNSET:
            field_dict["topics"] = topics
        if sensitivity is not UNSET:
            field_dict["sensitivity"] = sensitivity
        if priority is not UNSET:
            field_dict["priority"] = priority
        if disclosure is not UNSET:
            field_dict["disclosure"] = disclosure
        if glossary is not UNSET:
            field_dict["glossary"] = glossary
        if valid_to is not UNSET:
            field_dict["validTo"] = valid_to
        if plaintext_ok is not UNSET:
            field_dict["plaintextOk"] = plaintext_ok

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_entry_request_when import CreateEntryRequestWhen  # noqa: PLC0415
        from ..models.variant_input import VariantInput  # noqa: PLC0415

        d = dict(src_dict)
        circle = d.pop("circle", UNSET)

        title = d.pop("title", UNSET)

        content = d.pop("content", UNSET)

        _when = d.pop("when", UNSET)
        when: CreateEntryRequestWhen | Unset
        if isinstance(_when, Unset):
            when = UNSET
        else:
            when = CreateEntryRequestWhen.from_dict(_when)

        _variants = d.pop("variants", UNSET)
        variants: list[VariantInput] | Unset = UNSET
        if _variants is not UNSET:
            variants = []
            for variants_item_data in _variants:
                variants_item = VariantInput.from_dict(variants_item_data)

                variants.append(variants_item)

        topics = cast(list[str], d.pop("topics", UNSET))

        _sensitivity = d.pop("sensitivity", UNSET)
        sensitivity: CreateEntryRequestSensitivity | Unset
        if isinstance(_sensitivity, Unset):
            sensitivity = UNSET
        else:
            sensitivity = CreateEntryRequestSensitivity(_sensitivity)

        priority = d.pop("priority", UNSET)

        disclosure = d.pop("disclosure", UNSET)

        glossary = cast(list[str], d.pop("glossary", UNSET))

        _valid_to = d.pop("validTo", UNSET)
        valid_to: datetime.datetime | Unset
        if isinstance(_valid_to, Unset):
            valid_to = UNSET
        else:
            valid_to = datetime.datetime.fromisoformat(_valid_to)

        plaintext_ok = d.pop("plaintextOk", UNSET)

        create_entry_request = cls(
            circle=circle,
            title=title,
            content=content,
            when=when,
            variants=variants,
            topics=topics,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            glossary=glossary,
            valid_to=valid_to,
            plaintext_ok=plaintext_ok,
        )

        create_entry_request.additional_properties = d
        return create_entry_request

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
