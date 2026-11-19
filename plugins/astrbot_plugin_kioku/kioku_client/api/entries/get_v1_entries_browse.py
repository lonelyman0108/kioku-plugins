from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.entry_browse_response import EntryBrowseResponse
from ...models.error_response import ErrorResponse
from ...models.get_v1_entries_browse_facets import GetV1EntriesBrowseFacets
from ...models.get_v1_entries_browse_group_by import GetV1EntriesBrowseGroupBy
from ...models.get_v1_entries_browse_kind import GetV1EntriesBrowseKind
from ...types import UNSET, Unset
from typing import cast


def _get_kwargs(
    *,
    group_by: GetV1EntriesBrowseGroupBy | Unset = GetV1EntriesBrowseGroupBy.TOPIC,
    circle: str | Unset = UNSET,
    kind: GetV1EntriesBrowseKind | Unset = UNSET,
    topic: str | Unset = UNSET,
    facets: GetV1EntriesBrowseFacets | Unset = UNSET,
    query: str | Unset = UNSET,
    limit: int | Unset = 100,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    json_group_by: str | Unset = UNSET
    if not isinstance(group_by, Unset):
        json_group_by = group_by.value

    params["groupBy"] = json_group_by

    params["circle"] = circle

    json_kind: str | Unset = UNSET
    if not isinstance(kind, Unset):
        json_kind = kind.value

    params["kind"] = json_kind

    params["topic"] = topic

    json_facets: dict[str, Any] | Unset = UNSET
    if not isinstance(facets, Unset):
        json_facets = facets.to_dict()
    if not isinstance(json_facets, Unset):
        params.update(json_facets)

    params["query"] = query

    params["limit"] = limit

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/entries/browse",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> EntryBrowseResponse | ErrorResponse | None:
    if response.status_code == 200:
        response_200 = EntryBrowseResponse.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = ErrorResponse.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = ErrorResponse.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = ErrorResponse.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = ErrorResponse.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = ErrorResponse.from_dict(response.json())

        return response_409

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[EntryBrowseResponse | ErrorResponse]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    group_by: GetV1EntriesBrowseGroupBy | Unset = GetV1EntriesBrowseGroupBy.TOPIC,
    circle: str | Unset = UNSET,
    kind: GetV1EntriesBrowseKind | Unset = UNSET,
    topic: str | Unset = UNSET,
    facets: GetV1EntriesBrowseFacets | Unset = UNSET,
    query: str | Unset = UNSET,
    limit: int | Unset = 100,
) -> Response[EntryBrowseResponse | ErrorResponse]:
    """按维度分组浏览可见的词条索引与多变体切面概览

    Args:
        group_by (GetV1EntriesBrowseGroupBy | Unset):  Default: GetV1EntriesBrowseGroupBy.TOPIC.
        circle (str | Unset):
        kind (GetV1EntriesBrowseKind | Unset):
        topic (str | Unset):
        facets (GetV1EntriesBrowseFacets | Unset):
        query (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EntryBrowseResponse | ErrorResponse]
    """

    kwargs = _get_kwargs(
        group_by=group_by,
        circle=circle,
        kind=kind,
        topic=topic,
        facets=facets,
        query=query,
        limit=limit,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    group_by: GetV1EntriesBrowseGroupBy | Unset = GetV1EntriesBrowseGroupBy.TOPIC,
    circle: str | Unset = UNSET,
    kind: GetV1EntriesBrowseKind | Unset = UNSET,
    topic: str | Unset = UNSET,
    facets: GetV1EntriesBrowseFacets | Unset = UNSET,
    query: str | Unset = UNSET,
    limit: int | Unset = 100,
) -> EntryBrowseResponse | ErrorResponse | None:
    """按维度分组浏览可见的词条索引与多变体切面概览

    Args:
        group_by (GetV1EntriesBrowseGroupBy | Unset):  Default: GetV1EntriesBrowseGroupBy.TOPIC.
        circle (str | Unset):
        kind (GetV1EntriesBrowseKind | Unset):
        topic (str | Unset):
        facets (GetV1EntriesBrowseFacets | Unset):
        query (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EntryBrowseResponse | ErrorResponse
    """

    return sync_detailed(
        client=client,
        group_by=group_by,
        circle=circle,
        kind=kind,
        topic=topic,
        facets=facets,
        query=query,
        limit=limit,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    group_by: GetV1EntriesBrowseGroupBy | Unset = GetV1EntriesBrowseGroupBy.TOPIC,
    circle: str | Unset = UNSET,
    kind: GetV1EntriesBrowseKind | Unset = UNSET,
    topic: str | Unset = UNSET,
    facets: GetV1EntriesBrowseFacets | Unset = UNSET,
    query: str | Unset = UNSET,
    limit: int | Unset = 100,
) -> Response[EntryBrowseResponse | ErrorResponse]:
    """按维度分组浏览可见的词条索引与多变体切面概览

    Args:
        group_by (GetV1EntriesBrowseGroupBy | Unset):  Default: GetV1EntriesBrowseGroupBy.TOPIC.
        circle (str | Unset):
        kind (GetV1EntriesBrowseKind | Unset):
        topic (str | Unset):
        facets (GetV1EntriesBrowseFacets | Unset):
        query (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EntryBrowseResponse | ErrorResponse]
    """

    kwargs = _get_kwargs(
        group_by=group_by,
        circle=circle,
        kind=kind,
        topic=topic,
        facets=facets,
        query=query,
        limit=limit,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    group_by: GetV1EntriesBrowseGroupBy | Unset = GetV1EntriesBrowseGroupBy.TOPIC,
    circle: str | Unset = UNSET,
    kind: GetV1EntriesBrowseKind | Unset = UNSET,
    topic: str | Unset = UNSET,
    facets: GetV1EntriesBrowseFacets | Unset = UNSET,
    query: str | Unset = UNSET,
    limit: int | Unset = 100,
) -> EntryBrowseResponse | ErrorResponse | None:
    """按维度分组浏览可见的词条索引与多变体切面概览

    Args:
        group_by (GetV1EntriesBrowseGroupBy | Unset):  Default: GetV1EntriesBrowseGroupBy.TOPIC.
        circle (str | Unset):
        kind (GetV1EntriesBrowseKind | Unset):
        topic (str | Unset):
        facets (GetV1EntriesBrowseFacets | Unset):
        query (str | Unset):
        limit (int | Unset):  Default: 100.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EntryBrowseResponse | ErrorResponse
    """

    return (
        await asyncio_detailed(
            client=client,
            group_by=group_by,
            circle=circle,
            kind=kind,
            topic=topic,
            facets=facets,
            query=query,
            limit=limit,
        )
    ).parsed
