from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.who_am_i_vocabulary_item_match_mode import WhoAmIVocabularyItemMatchMode
from typing import cast

if TYPE_CHECKING:
    from ..models.who_am_i_vocabulary_item_terms_item import WhoAmIVocabularyItemTermsItem


T = TypeVar("T", bound="WhoAmIVocabularyItem")


@_attrs_define
class WhoAmIVocabularyItem:
    """
    Attributes:
        key (str):
        name (str):
        match_mode (WhoAmIVocabularyItemMatchMode):
        terms (list[WhoAmIVocabularyItemTermsItem]):
    """

    key: str
    name: str
    match_mode: WhoAmIVocabularyItemMatchMode
    terms: list[WhoAmIVocabularyItemTermsItem]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.who_am_i_vocabulary_item_terms_item import WhoAmIVocabularyItemTermsItem  # noqa: PLC0415

        key = self.key

        name = self.name

        match_mode = self.match_mode.value

        terms = []
        for terms_item_data in self.terms:
            terms_item = terms_item_data.to_dict()
            terms.append(terms_item)

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "key": key,
                "name": name,
                "matchMode": match_mode,
                "terms": terms,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.who_am_i_vocabulary_item_terms_item import WhoAmIVocabularyItemTermsItem  # noqa: PLC0415

        d = dict(src_dict)
        key = d.pop("key")

        name = d.pop("name")

        match_mode = WhoAmIVocabularyItemMatchMode(d.pop("matchMode"))

        terms = []
        _terms = d.pop("terms")
        for terms_item_data in _terms:
            terms_item = WhoAmIVocabularyItemTermsItem.from_dict(terms_item_data)

            terms.append(terms_item)

        who_am_i_vocabulary_item = cls(
            key=key,
            name=name,
            match_mode=match_mode,
            terms=terms,
        )

        who_am_i_vocabulary_item.additional_properties = d
        return who_am_i_vocabulary_item

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
