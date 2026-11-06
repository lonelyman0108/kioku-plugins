from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.error_response import ErrorResponse
from ...types import UNSET, Unset
from typing import cast
from uuid import UUID


def _get_kwargs(
    *,
    uri: str,
    expected_id: UUID | Unset = UNSET,
    expected_version: int | None | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["uri"] = uri

    json_expected_id: str | Unset = UNSET
    if not isinstance(expected_id, Unset):
        json_expected_id = str(expected_id)
    params["expectedId"] = json_expected_id

    json_expected_version: int | None | Unset
    if isinstance(expected_version, Unset):
        json_expected_version = UNSET
    else:
        json_expected_version = expected_version
    params["expectedVersion"] = json_expected_version

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "delete",
        "url": "/v1/memories",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Any | ErrorResponse | None:
    if response.status_code == 204:
        response_204 = cast(Any, None)
        return response_204

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
) -> Response[Any | ErrorResponse]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    uri: str,
    expected_id: UUID | Unset = UNSET,
    expected_version: int | None | Unset = UNSET,
) -> Response[Any | ErrorResponse]:
    """删除记忆（保留历史事件）

    Args:
        uri (str):
        expected_id (UUID | Unset):
        expected_version (int | None | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | ErrorResponse]
    """

    kwargs = _get_kwargs(
        uri=uri,
        expected_id=expected_id,
        expected_version=expected_version,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    uri: str,
    expected_id: UUID | Unset = UNSET,
    expected_version: int | None | Unset = UNSET,
) -> Any | ErrorResponse | None:
    """删除记忆（保留历史事件）

    Args:
        uri (str):
        expected_id (UUID | Unset):
        expected_version (int | None | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | ErrorResponse
    """

    return sync_detailed(
        client=client,
        uri=uri,
        expected_id=expected_id,
        expected_version=expected_version,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    uri: str,
    expected_id: UUID | Unset = UNSET,
    expected_version: int | None | Unset = UNSET,
) -> Response[Any | ErrorResponse]:
    """删除记忆（保留历史事件）

    Args:
        uri (str):
        expected_id (UUID | Unset):
        expected_version (int | None | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Any | ErrorResponse]
    """

    kwargs = _get_kwargs(
        uri=uri,
        expected_id=expected_id,
        expected_version=expected_version,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    uri: str,
    expected_id: UUID | Unset = UNSET,
    expected_version: int | None | Unset = UNSET,
) -> Any | ErrorResponse | None:
    """删除记忆（保留历史事件）

    Args:
        uri (str):
        expected_id (UUID | Unset):
        expected_version (int | None | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Any | ErrorResponse
    """

    return (
        await asyncio_detailed(
            client=client,
            uri=uri,
            expected_id=expected_id,
            expected_version=expected_version,
        )
    ).parsed
