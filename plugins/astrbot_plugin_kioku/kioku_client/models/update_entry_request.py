from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.update_entry_request_sensitivity import UpdateEntryRequestSensitivity
from typing import cast
import datetime

if TYPE_CHECKING:
    from ..models.update_entry_request_remove_variant_whens_item import (
        UpdateEntryRequestRemoveVariantWhensItem,
    )
    from ..models.update_entry_request_when import UpdateEntryRequestWhen
    from ..models.variant_input import VariantInput


T = TypeVar("T", bound="UpdateEntryRequest")


@_attrs_define
class UpdateEntryRequest:
    """
    Attributes:
        id (str):
        circle (str | Unset):
        expected_version (int | Unset):
        title (str | Unset):
        content (str | Unset):
        when (UpdateEntryRequestWhen | Unset):
        variants (list[VariantInput] | Unset):
        upsert_variants (list[VariantInput] | Unset):
        remove_variant_whens (list[UpdateEntryRequestRemoveVariantWhensItem] | Unset):
        topics (list[str] | Unset):
        sensitivity (UpdateEntryRequestSensitivity | Unset):
        priority (int | Unset):
        disclosure (None | str | Unset):
        glossary_add (list[str] | Unset):
        glossary_remove (list[str] | Unset):
        valid_to (datetime.datetime | None | Unset): 有效到：ISO 8601 的时间，要带时区（例如 2026-12-31T23:59:00+08:00 或
            2026-12-31T15:59:00Z），不带时区的会被拒绝；要比现在晚至少一分钟。到期后不再召回、不进 boot；填 null 清掉，一直有效
        plaintext_ok (bool | Unset): 正文里新增的疑似明文确实不是凭据时设为 true：照常写入，这条词条进待处理。是凭据时先存成凭据，正文写占位符
    """

    id: str
    circle: str | Unset = UNSET
    expected_version: int | Unset = UNSET
    title: str | Unset = UNSET
    content: str | Unset = UNSET
    when: UpdateEntryRequestWhen | Unset = UNSET
    variants: list[VariantInput] | Unset = UNSET
    upsert_variants: list[VariantInput] | Unset = UNSET
    remove_variant_whens: list[UpdateEntryRequestRemoveVariantWhensItem] | Unset = UNSET
    topics: list[str] | Unset = UNSET
    sensitivity: UpdateEntryRequestSensitivity | Unset = UNSET
    priority: int | Unset = UNSET
    disclosure: None | str | Unset = UNSET
    glossary_add: list[str] | Unset = UNSET
    glossary_remove: list[str] | Unset = UNSET
    valid_to: datetime.datetime | None | Unset = UNSET
    plaintext_ok: bool | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.update_entry_request_remove_variant_whens_item import (
            UpdateEntryRequestRemoveVariantWhensItem,
        )  # noqa: PLC0415
        from ..models.update_entry_request_when import UpdateEntryRequestWhen  # noqa: PLC0415
        from ..models.variant_input import VariantInput  # noqa: PLC0415

        id = self.id

        circle = self.circle

        expected_version = self.expected_version

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

        upsert_variants: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.upsert_variants, Unset):
            upsert_variants = []
            for upsert_variants_item_data in self.upsert_variants:
                upsert_variants_item = upsert_variants_item_data.to_dict()
                upsert_variants.append(upsert_variants_item)

        remove_variant_whens: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.remove_variant_whens, Unset):
            remove_variant_whens = []
            for remove_variant_whens_item_data in self.remove_variant_whens:
                remove_variant_whens_item = remove_variant_whens_item_data.to_dict()
                remove_variant_whens.append(remove_variant_whens_item)

        topics: list[str] | Unset = UNSET
        if not isinstance(self.topics, Unset):
            topics = self.topics

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
                "id": id,
            }
        )
        if circle is not UNSET:
            field_dict["circle"] = circle
        if expected_version is not UNSET:
            field_dict["expectedVersion"] = expected_version
        if title is not UNSET:
            field_dict["title"] = title
        if content is not UNSET:
            field_dict["content"] = content
        if when is not UNSET:
            field_dict["when"] = when
        if variants is not UNSET:
            field_dict["variants"] = variants
        if upsert_variants is not UNSET:
            field_dict["upsertVariants"] = upsert_variants
        if remove_variant_whens is not UNSET:
            field_dict["removeVariantWhens"] = remove_variant_whens
        if topics is not UNSET:
            field_dict["topics"] = topics
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
        from ..models.update_entry_request_remove_variant_whens_item import (
            UpdateEntryRequestRemoveVariantWhensItem,
        )  # noqa: PLC0415
        from ..models.update_entry_request_when import UpdateEntryRequestWhen  # noqa: PLC0415
        from ..models.variant_input import VariantInput  # noqa: PLC0415

        d = dict(src_dict)
        id = d.pop("id")

        circle = d.pop("circle", UNSET)

        expected_version = d.pop("expectedVersion", UNSET)

        title = d.pop("title", UNSET)

        content = d.pop("content", UNSET)

        _when = d.pop("when", UNSET)
        when: UpdateEntryRequestWhen | Unset
        if isinstance(_when, Unset):
            when = UNSET
        else:
            when = UpdateEntryRequestWhen.from_dict(_when)

        _variants = d.pop("variants", UNSET)
        variants: list[VariantInput] | Unset = UNSET
        if _variants is not UNSET:
            variants = []
            for variants_item_data in _variants:
                variants_item = VariantInput.from_dict(variants_item_data)

                variants.append(variants_item)

        _upsert_variants = d.pop("upsertVariants", UNSET)
        upsert_variants: list[VariantInput] | Unset = UNSET
        if _upsert_variants is not UNSET:
            upsert_variants = []
            for upsert_variants_item_data in _upsert_variants:
                upsert_variants_item = VariantInput.from_dict(upsert_variants_item_data)

                upsert_variants.append(upsert_variants_item)

        _remove_variant_whens = d.pop("removeVariantWhens", UNSET)
        remove_variant_whens: list[UpdateEntryRequestRemoveVariantWhensItem] | Unset = UNSET
        if _remove_variant_whens is not UNSET:
            remove_variant_whens = []
            for remove_variant_whens_item_data in _remove_variant_whens:
                remove_variant_whens_item = UpdateEntryRequestRemoveVariantWhensItem.from_dict(
                    remove_variant_whens_item_data
                )

                remove_variant_whens.append(remove_variant_whens_item)

        topics = cast(list[str], d.pop("topics", UNSET))

        _sensitivity = d.pop("sensitivity", UNSET)
        sensitivity: UpdateEntryRequestSensitivity | Unset
        if isinstance(_sensitivity, Unset):
            sensitivity = UNSET
        else:
            sensitivity = UpdateEntryRequestSensitivity(_sensitivity)

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

        update_entry_request = cls(
            id=id,
            circle=circle,
            expected_version=expected_version,
            title=title,
            content=content,
            when=when,
            variants=variants,
            upsert_variants=upsert_variants,
            remove_variant_whens=remove_variant_whens,
            topics=topics,
            sensitivity=sensitivity,
            priority=priority,
            disclosure=disclosure,
            glossary_add=glossary_add,
            glossary_remove=glossary_remove,
            valid_to=valid_to,
            plaintext_ok=plaintext_ok,
        )

        update_entry_request.additional_properties = d
        return update_entry_request

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
