from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..models.bind_result_status import BindResultStatus
from ..types import UNSET, Unset
from typing import cast
import datetime

if TYPE_CHECKING:
    from ..models.bind_target import BindTarget


T = TypeVar("T", bound="BindResult")


@_attrs_define
class BindResult:
    """
    Attributes:
        status (BindResultStatus):
        needs_approval (bool):
        expires_at (datetime.datetime | None):
        target (BindTarget | Unset):
    """

    status: BindResultStatus
    needs_approval: bool
    expires_at: datetime.datetime | None
    target: BindTarget | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.bind_target import BindTarget  # noqa: PLC0415

        status = self.status.value

        needs_approval = self.needs_approval

        expires_at: None | str
        if isinstance(self.expires_at, datetime.datetime):
            expires_at = self.expires_at.isoformat()
        else:
            expires_at = self.expires_at

        target: dict[str, Any] | Unset = UNSET
        if not isinstance(self.target, Unset):
            target = self.target.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "status": status,
                "needsApproval": needs_approval,
                "expiresAt": expires_at,
            }
        )
        if target is not UNSET:
            field_dict["target"] = target

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.bind_target import BindTarget  # noqa: PLC0415

        d = dict(src_dict)
        status = BindResultStatus(d.pop("status"))

        needs_approval = d.pop("needsApproval")

        def _parse_expires_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                expires_at_type_0 = datetime.datetime.fromisoformat(data)

                return expires_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        expires_at = _parse_expires_at(d.pop("expiresAt"))

        _target = d.pop("target", UNSET)
        target: BindTarget | Unset
        if isinstance(_target, Unset):
            target = UNSET
        else:
            target = BindTarget.from_dict(_target)

        bind_result = cls(
            status=status,
            needs_approval=needs_approval,
            expires_at=expires_at,
            target=target,
        )

        bind_result.additional_properties = d
        return bind_result

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
