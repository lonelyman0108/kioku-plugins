from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.client_info import ClientInfo
    from ..models.who_am_i_context_facets import WhoAmIContextFacets
    from ..models.who_am_i_linked_circles_item import WhoAmILinkedCirclesItem
    from ..models.who_am_i_persona_type_0 import WhoAmIPersonaType0
    from ..models.who_am_i_primary_circle import WhoAmIPrimaryCircle
    from ..models.who_am_i_resolved_facets import WhoAmIResolvedFacets
    from ..models.who_am_i_scopes import WhoAmIScopes
    from ..models.who_am_i_vocabulary_item import WhoAmIVocabularyItem


T = TypeVar("T", bound="WhoAmI")


@_attrs_define
class WhoAmI:
    """
    Attributes:
        primary_circle (WhoAmIPrimaryCircle):
        linked_circles (list[WhoAmILinkedCirclesItem]):
        client (ClientInfo):
        persona (None | WhoAmIPersonaType0):
        context_facets (WhoAmIContextFacets):
        resolved_facets (WhoAmIResolvedFacets):
        vocabulary (list[WhoAmIVocabularyItem]):
        scopes (WhoAmIScopes):
        account_name (str | Unset):
    """

    primary_circle: WhoAmIPrimaryCircle
    linked_circles: list[WhoAmILinkedCirclesItem]
    client: ClientInfo
    persona: None | WhoAmIPersonaType0
    context_facets: WhoAmIContextFacets
    resolved_facets: WhoAmIResolvedFacets
    vocabulary: list[WhoAmIVocabularyItem]
    scopes: WhoAmIScopes
    account_name: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.client_info import ClientInfo  # noqa: PLC0415
        from ..models.who_am_i_context_facets import WhoAmIContextFacets  # noqa: PLC0415
        from ..models.who_am_i_linked_circles_item import WhoAmILinkedCirclesItem  # noqa: PLC0415
        from ..models.who_am_i_persona_type_0 import WhoAmIPersonaType0  # noqa: PLC0415
        from ..models.who_am_i_primary_circle import WhoAmIPrimaryCircle  # noqa: PLC0415
        from ..models.who_am_i_resolved_facets import WhoAmIResolvedFacets  # noqa: PLC0415
        from ..models.who_am_i_scopes import WhoAmIScopes  # noqa: PLC0415
        from ..models.who_am_i_vocabulary_item import WhoAmIVocabularyItem  # noqa: PLC0415

        primary_circle = self.primary_circle.to_dict()

        linked_circles = []
        for linked_circles_item_data in self.linked_circles:
            linked_circles_item = linked_circles_item_data.to_dict()
            linked_circles.append(linked_circles_item)

        client = self.client.to_dict()

        persona: dict[str, Any] | None
        if isinstance(self.persona, WhoAmIPersonaType0):
            persona = self.persona.to_dict()
        else:
            persona = self.persona

        context_facets = self.context_facets.to_dict()

        resolved_facets = self.resolved_facets.to_dict()

        vocabulary = []
        for vocabulary_item_data in self.vocabulary:
            vocabulary_item = vocabulary_item_data.to_dict()
            vocabulary.append(vocabulary_item)

        scopes = self.scopes.to_dict()

        account_name = self.account_name

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "primaryCircle": primary_circle,
                "linkedCircles": linked_circles,
                "client": client,
                "persona": persona,
                "contextFacets": context_facets,
                "resolvedFacets": resolved_facets,
                "vocabulary": vocabulary,
                "scopes": scopes,
            }
        )
        if account_name is not UNSET:
            field_dict["accountName"] = account_name

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.client_info import ClientInfo  # noqa: PLC0415
        from ..models.who_am_i_context_facets import WhoAmIContextFacets  # noqa: PLC0415
        from ..models.who_am_i_linked_circles_item import WhoAmILinkedCirclesItem  # noqa: PLC0415
        from ..models.who_am_i_persona_type_0 import WhoAmIPersonaType0  # noqa: PLC0415
        from ..models.who_am_i_primary_circle import WhoAmIPrimaryCircle  # noqa: PLC0415
        from ..models.who_am_i_resolved_facets import WhoAmIResolvedFacets  # noqa: PLC0415
        from ..models.who_am_i_scopes import WhoAmIScopes  # noqa: PLC0415
        from ..models.who_am_i_vocabulary_item import WhoAmIVocabularyItem  # noqa: PLC0415

        d = dict(src_dict)
        primary_circle = WhoAmIPrimaryCircle.from_dict(d.pop("primaryCircle"))

        linked_circles = []
        _linked_circles = d.pop("linkedCircles")
        for linked_circles_item_data in _linked_circles:
            linked_circles_item = WhoAmILinkedCirclesItem.from_dict(linked_circles_item_data)

            linked_circles.append(linked_circles_item)

        client = ClientInfo.from_dict(d.pop("client"))

        def _parse_persona(data: object) -> None | WhoAmIPersonaType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                persona_type_0 = WhoAmIPersonaType0.from_dict(data)

                return persona_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | WhoAmIPersonaType0, data)

        persona = _parse_persona(d.pop("persona"))

        context_facets = WhoAmIContextFacets.from_dict(d.pop("contextFacets"))

        resolved_facets = WhoAmIResolvedFacets.from_dict(d.pop("resolvedFacets"))

        vocabulary = []
        _vocabulary = d.pop("vocabulary")
        for vocabulary_item_data in _vocabulary:
            vocabulary_item = WhoAmIVocabularyItem.from_dict(vocabulary_item_data)

            vocabulary.append(vocabulary_item)

        scopes = WhoAmIScopes.from_dict(d.pop("scopes"))

        account_name = d.pop("accountName", UNSET)

        who_am_i = cls(
            primary_circle=primary_circle,
            linked_circles=linked_circles,
            client=client,
            persona=persona,
            context_facets=context_facets,
            resolved_facets=resolved_facets,
            vocabulary=vocabulary,
            scopes=scopes,
            account_name=account_name,
        )

        who_am_i.additional_properties = d
        return who_am_i

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
