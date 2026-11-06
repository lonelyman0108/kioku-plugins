from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.host_output import HostOutput


T = TypeVar("T", bound="LifecycleResponse")


@_attrs_define
class LifecycleResponse:
    """
    Attributes:
        host_output (HostOutput):
        node_uris (list[str]):
    """

    host_output: HostOutput
    node_uris: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.host_output import HostOutput  # noqa: PLC0415

        host_output = self.host_output.to_dict()

        node_uris = self.node_uris

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "hostOutput": host_output,
                "nodeUris": node_uris,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.host_output import HostOutput  # noqa: PLC0415

        d = dict(src_dict)
        host_output = HostOutput.from_dict(d.pop("hostOutput"))

        node_uris = cast(list[str], d.pop("nodeUris"))

        lifecycle_response = cls(
            host_output=host_output,
            node_uris=node_uris,
        )

        lifecycle_response.additional_properties = d
        return lifecycle_response

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
