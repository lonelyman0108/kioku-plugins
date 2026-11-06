from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from ..types import UNSET, Unset


T = TypeVar("T", bound="LifecycleProject")


@_attrs_define
class LifecycleProject:
    """
    Attributes:
        dir_name (str | Unset):
        repo_name (str | Unset):
    """

    dir_name: str | Unset = UNSET
    repo_name: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        dir_name = self.dir_name

        repo_name = self.repo_name

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if dir_name is not UNSET:
            field_dict["dirName"] = dir_name
        if repo_name is not UNSET:
            field_dict["repoName"] = repo_name

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        dir_name = d.pop("dirName", UNSET)

        repo_name = d.pop("repoName", UNSET)

        lifecycle_project = cls(
            dir_name=dir_name,
            repo_name=repo_name,
        )

        lifecycle_project.additional_properties = d
        return lifecycle_project

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
