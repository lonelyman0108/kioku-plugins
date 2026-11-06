from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.session_start_event_event import SessionStartEventEvent
from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
    from ..models.lifecycle_project import LifecycleProject
    from ..models.session_context import SessionContext


T = TypeVar("T", bound="SessionStartEvent")


@_attrs_define
class SessionStartEvent:
    """
    Attributes:
        event (SessionStartEventEvent):
        session_id (str | Unset):
        context (SessionContext | Unset):
        project (LifecycleProject | Unset):
    """

    event: SessionStartEventEvent
    session_id: str | Unset = UNSET
    context: SessionContext | Unset = UNSET
    project: LifecycleProject | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.lifecycle_project import LifecycleProject  # noqa: PLC0415
        from ..models.session_context import SessionContext  # noqa: PLC0415

        event = self.event.value

        session_id = self.session_id

        context: dict[str, Any] | Unset = UNSET
        if not isinstance(self.context, Unset):
            context = self.context.to_dict()

        project: dict[str, Any] | Unset = UNSET
        if not isinstance(self.project, Unset):
            project = self.project.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "event": event,
            }
        )
        if session_id is not UNSET:
            field_dict["sessionId"] = session_id
        if context is not UNSET:
            field_dict["context"] = context
        if project is not UNSET:
            field_dict["project"] = project

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.lifecycle_project import LifecycleProject  # noqa: PLC0415
        from ..models.session_context import SessionContext  # noqa: PLC0415

        d = dict(src_dict)
        event = SessionStartEventEvent(d.pop("event"))

        session_id = d.pop("sessionId", UNSET)

        _context = d.pop("context", UNSET)
        context: SessionContext | Unset
        if isinstance(_context, Unset):
            context = UNSET
        else:
            context = SessionContext.from_dict(_context)

        _project = d.pop("project", UNSET)
        project: LifecycleProject | Unset
        if isinstance(_project, Unset):
            project = UNSET
        else:
            project = LifecycleProject.from_dict(_project)

        session_start_event = cls(
            event=event,
            session_id=session_id,
            context=context,
            project=project,
        )

        session_start_event.additional_properties = d
        return session_start_event

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
