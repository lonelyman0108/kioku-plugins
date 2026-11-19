from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.entry_variant_view_when import EntryVariantViewWhen


T = TypeVar("T", bound="EntryVariantView")


@_attrs_define
class EntryVariantView:
    """
    Attributes:
        id (UUID):
        when (EntryVariantViewWhen):
        when_signature (str):
        sort_order (int):
        content (None | str):
        updated_at (str):
    """

    id: UUID
    when: EntryVariantViewWhen
    when_signature: str
    sort_order: int
    content: None | str
    updated_at: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.entry_variant_view_when import EntryVariantViewWhen  # noqa: PLC0415

        id = str(self.id)

        when = self.when.to_dict()

        when_signature = self.when_signature

        sort_order = self.sort_order

        content: None | str
        content = self.content

        updated_at = self.updated_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "id": id,
                "when": when,
                "whenSignature": when_signature,
                "sortOrder": sort_order,
                "content": content,
                "updatedAt": updated_at,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.entry_variant_view_when import EntryVariantViewWhen  # noqa: PLC0415

        d = dict(src_dict)
        id = UUID(d.pop("id"))

        when = EntryVariantViewWhen.from_dict(d.pop("when"))

        when_signature = d.pop("whenSignature")

        sort_order = d.pop("sortOrder")

        def _parse_content(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        content = _parse_content(d.pop("content"))

        updated_at = d.pop("updatedAt")

        entry_variant_view = cls(
            id=id,
            when=when,
            when_signature=when_signature,
            sort_order=sort_order,
            content=content,
            updated_at=updated_at,
        )

        entry_variant_view.additional_properties = d
        return entry_variant_view

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
