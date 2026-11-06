from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.chat_type import ChatType
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
    from ..models.platform_ref import PlatformRef


T = TypeVar("T", bound="SessionContext")


@_attrs_define
class SessionContext:
    """
    Attributes:
        chat_type (ChatType):
        platform (str | Unset):
        group (PlatformRef | Unset):
        sender (PlatformRef | Unset):
    """

    chat_type: ChatType
    platform: str | Unset = UNSET
    group: PlatformRef | Unset = UNSET
    sender: PlatformRef | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.platform_ref import PlatformRef  # noqa: PLC0415

        chat_type = self.chat_type.value

        platform = self.platform

        group: dict[str, Any] | Unset = UNSET
        if not isinstance(self.group, Unset):
            group = self.group.to_dict()

        sender: dict[str, Any] | Unset = UNSET
        if not isinstance(self.sender, Unset):
            sender = self.sender.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chatType": chat_type,
            }
        )
        if platform is not UNSET:
            field_dict["platform"] = platform
        if group is not UNSET:
            field_dict["group"] = group
        if sender is not UNSET:
            field_dict["sender"] = sender

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.platform_ref import PlatformRef  # noqa: PLC0415

        d = dict(src_dict)
        chat_type = ChatType(d.pop("chatType"))

        platform = d.pop("platform", UNSET)

        _group = d.pop("group", UNSET)
        group: PlatformRef | Unset
        if isinstance(_group, Unset):
            group = UNSET
        else:
            group = PlatformRef.from_dict(_group)

        _sender = d.pop("sender", UNSET)
        sender: PlatformRef | Unset
        if isinstance(_sender, Unset):
            sender = UNSET
        else:
            sender = PlatformRef.from_dict(_sender)

        session_context = cls(
            chat_type=chat_type,
            platform=platform,
            group=group,
            sender=sender,
        )

        session_context.additional_properties = d
        return session_context

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
