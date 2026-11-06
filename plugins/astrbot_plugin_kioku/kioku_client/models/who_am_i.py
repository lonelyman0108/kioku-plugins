from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast
from uuid import UUID

if TYPE_CHECKING:
    from ..models.app_info import AppInfo
    from ..models.who_am_i_scopes import WhoAmIScopes


T = TypeVar("T", bound="WhoAmI")


@_attrs_define
class WhoAmI:
    """
    Attributes:
        space_id (UUID):
        app (AppInfo):
        scopes (WhoAmIScopes):
    """

    space_id: UUID
    app: AppInfo
    scopes: WhoAmIScopes
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.app_info import AppInfo  # noqa: PLC0415
        from ..models.who_am_i_scopes import WhoAmIScopes  # noqa: PLC0415

        space_id = str(self.space_id)

        app = self.app.to_dict()

        scopes = self.scopes.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "spaceId": space_id,
                "app": app,
                "scopes": scopes,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.app_info import AppInfo  # noqa: PLC0415
        from ..models.who_am_i_scopes import WhoAmIScopes  # noqa: PLC0415

        d = dict(src_dict)
        space_id = UUID(d.pop("spaceId"))

        app = AppInfo.from_dict(d.pop("app"))

        scopes = WhoAmIScopes.from_dict(d.pop("scopes"))

        who_am_i = cls(
            space_id=space_id,
            app=app,
            scopes=scopes,
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
