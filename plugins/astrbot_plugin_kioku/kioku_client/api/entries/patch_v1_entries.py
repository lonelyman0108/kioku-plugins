from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.entry_view import EntryView
from ...models.entry_write_error import EntryWriteError
from ...models.error_response import ErrorResponse
from ...models.update_entry_request import UpdateEntryRequest
from typing import cast


def _get_kwargs(
    *,
    body: UpdateEntryRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "patch",
        "url": "/v1/entries",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> EntryView | EntryWriteError | ErrorResponse | None:
    if response.status_code == 200:
        response_200 = EntryView.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = EntryWriteError.from_dict(response.json())

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
) -> Response[EntryView | EntryWriteError | ErrorResponse]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: UpdateEntryRequest,
) -> Response[EntryView | EntryWriteError | ErrorResponse]:
    """修改词条内容、按切面追加/覆盖或删除变体切片、主题标签、敏感级与有效期

    Args:
        body (UpdateEntryRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EntryView | EntryWriteError | ErrorResponse]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: UpdateEntryRequest,
) -> EntryView | EntryWriteError | ErrorResponse | None:
    """修改词条内容、按切面追加/覆盖或删除变体切片、主题标签、敏感级与有效期

    Args:
        body (UpdateEntryRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EntryView | EntryWriteError | ErrorResponse
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: UpdateEntryRequest,
) -> Response[EntryView | EntryWriteError | ErrorResponse]:
    """修改词条内容、按切面追加/覆盖或删除变体切片、主题标签、敏感级与有效期

    Args:
        body (UpdateEntryRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EntryView | EntryWriteError | ErrorResponse]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: UpdateEntryRequest,
) -> EntryView | EntryWriteError | ErrorResponse | None:
    """修改词条内容、按切面追加/覆盖或删除变体切片、主题标签、敏感级与有效期

    Args:
        body (UpdateEntryRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EntryView | EntryWriteError | ErrorResponse
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
