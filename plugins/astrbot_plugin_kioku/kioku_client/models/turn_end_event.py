from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.turn_end_event_event import TurnEndEventEvent
from typing import cast

if TYPE_CHECKING:
    from ..models.session_context import SessionContext


T = TypeVar("T", bound="TurnEndEvent")


@_attrs_define
class TurnEndEvent:
    """
    Attributes:
        event (TurnEndEventEvent):
        session_id (str):
        user (str):
        reply (str):
        context (SessionContext | Unset):
    """

    event: TurnEndEventEvent
    session_id: str
    user: str
    reply: str
    context: SessionContext | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.session_context import SessionContext  # noqa: PLC0415

        event = self.event.value

        session_id = self.session_id

        user = self.user

        reply = self.reply

        context: dict[str, Any] | Unset = UNSET
        if not isinstance(self.context, Unset):
            context = self.context.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "event": event,
                "sessionId": session_id,
                "user": user,
                "reply": reply,
            }
        )
        if context is not UNSET:
            field_dict["context"] = context

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.session_context import SessionContext  # noqa: PLC0415

        d = dict(src_dict)
        event = TurnEndEventEvent(d.pop("event"))

        session_id = d.pop("sessionId")

        user = d.pop("user")

        reply = d.pop("reply")

        _context = d.pop("context", UNSET)
        context: SessionContext | Unset
        if isinstance(_context, Unset):
            context = UNSET
        else:
            context = SessionContext.from_dict(_context)

        turn_end_event = cls(
            event=event,
            session_id=session_id,
            user=user,
            reply=reply,
            context=context,
        )

        turn_end_event.additional_properties = d
        return turn_end_event

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
