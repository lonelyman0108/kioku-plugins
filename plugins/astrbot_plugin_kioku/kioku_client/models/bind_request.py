from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset
from typing import cast

if TYPE_CHECKING:
    from ..models.session_context import SessionContext


T = TypeVar("T", bound="BindRequest")


@_attrs_define
class BindRequest:
    """
    Attributes:
        code (str):
        context (SessionContext):
        confirm (bool | Unset):  Default: False.
    """

    code: str
    context: SessionContext
    confirm: bool | Unset = False
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.session_context import SessionContext  # noqa: PLC0415

        code = self.code

        context = self.context.to_dict()

        confirm = self.confirm

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "code": code,
                "context": context,
            }
        )
        if confirm is not UNSET:
            field_dict["confirm"] = confirm

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.session_context import SessionContext  # noqa: PLC0415

        d = dict(src_dict)
        code = d.pop("code")

        context = SessionContext.from_dict(d.pop("context"))

        confirm = d.pop("confirm", UNSET)

        bind_request = cls(
            code=code,
            context=context,
            confirm=confirm,
        )

        bind_request.additional_properties = d
        return bind_request

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
