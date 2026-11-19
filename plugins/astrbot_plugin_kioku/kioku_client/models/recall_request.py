from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, BinaryIO, TextIO, TYPE_CHECKING, Generator

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

from typing import cast

if TYPE_CHECKING:
    from ..models.lifecycle_project import LifecycleProject
    from ..models.recall_request_facets import RecallRequestFacets
    from ..models.session_context import SessionContext


T = TypeVar("T", bound="RecallRequest")


@_attrs_define
class RecallRequest:
    """
    Attributes:
        query (str):
        limit (int | Unset):
        facets (RecallRequestFacets | Unset):
        cross_circle (bool | Unset):  Default: True.
        include_subjects (bool | Unset):  Default: True.
        project (LifecycleProject | Unset):
        context (SessionContext | Unset):
    """

    query: str
    limit: int | Unset = UNSET
    facets: RecallRequestFacets | Unset = UNSET
    cross_circle: bool | Unset = True
    include_subjects: bool | Unset = True
    project: LifecycleProject | Unset = UNSET
    context: SessionContext | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.lifecycle_project import LifecycleProject  # noqa: PLC0415
        from ..models.recall_request_facets import RecallRequestFacets  # noqa: PLC0415
        from ..models.session_context import SessionContext  # noqa: PLC0415

        query = self.query

        limit = self.limit

        facets: dict[str, Any] | Unset = UNSET
        if not isinstance(self.facets, Unset):
            facets = self.facets.to_dict()

        cross_circle = self.cross_circle

        include_subjects = self.include_subjects

        project: dict[str, Any] | Unset = UNSET
        if not isinstance(self.project, Unset):
            project = self.project.to_dict()

        context: dict[str, Any] | Unset = UNSET
        if not isinstance(self.context, Unset):
            context = self.context.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "query": query,
            }
        )
        if limit is not UNSET:
            field_dict["limit"] = limit
        if facets is not UNSET:
            field_dict["facets"] = facets
        if cross_circle is not UNSET:
            field_dict["crossCircle"] = cross_circle
        if include_subjects is not UNSET:
            field_dict["includeSubjects"] = include_subjects
        if project is not UNSET:
            field_dict["project"] = project
        if context is not UNSET:
            field_dict["context"] = context

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.lifecycle_project import LifecycleProject  # noqa: PLC0415
        from ..models.recall_request_facets import RecallRequestFacets  # noqa: PLC0415
        from ..models.session_context import SessionContext  # noqa: PLC0415

        d = dict(src_dict)
        query = d.pop("query")

        limit = d.pop("limit", UNSET)

        _facets = d.pop("facets", UNSET)
        facets: RecallRequestFacets | Unset
        if isinstance(_facets, Unset):
            facets = UNSET
        else:
            facets = RecallRequestFacets.from_dict(_facets)

        cross_circle = d.pop("crossCircle", UNSET)

        include_subjects = d.pop("includeSubjects", UNSET)

        _project = d.pop("project", UNSET)
        project: LifecycleProject | Unset
        if isinstance(_project, Unset):
            project = UNSET
        else:
            project = LifecycleProject.from_dict(_project)

        _context = d.pop("context", UNSET)
        context: SessionContext | Unset
        if isinstance(_context, Unset):
            context = UNSET
        else:
            context = SessionContext.from_dict(_context)

        recall_request = cls(
            query=query,
            limit=limit,
            facets=facets,
            cross_circle=cross_circle,
            include_subjects=include_subjects,
            project=project,
            context=context,
        )

        recall_request.additional_properties = d
        return recall_request

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
