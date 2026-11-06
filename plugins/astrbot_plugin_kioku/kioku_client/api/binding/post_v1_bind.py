from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.bind_request import BindRequest
from ...models.bind_result import BindResult
from ...models.error_response import ErrorResponse
from typing import cast


def _get_kwargs(
    *,
    body: BindRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/bind",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> BindResult | ErrorResponse | None:
    if response.status_code == 200:
        response_200 = BindResult.from_dict(response.json())

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

    if response.status_code == 409:
        response_409 = ErrorResponse.from_dict(response.json())

        return response_409

    if response.status_code == 429:
        response_429 = ErrorResponse.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[BindResult | ErrorResponse]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: BindRequest,
) -> Response[BindResult | ErrorResponse]:
    """在另一个平台的私聊里使用绑定码：先预览要并到谁那里，同一个账号预览过之后带上 confirm
    再发才把这个平台账号的对象并进申请绑定码的对象。申请的对象标记了成员（这边没标记成同一个成员）时，还要那个成员在管理界面确认

    Args:
        body (BindRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[BindResult | ErrorResponse]
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
    body: BindRequest,
) -> BindResult | ErrorResponse | None:
    """在另一个平台的私聊里使用绑定码：先预览要并到谁那里，同一个账号预览过之后带上 confirm
    再发才把这个平台账号的对象并进申请绑定码的对象。申请的对象标记了成员（这边没标记成同一个成员）时，还要那个成员在管理界面确认

    Args:
        body (BindRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        BindResult | ErrorResponse
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: BindRequest,
) -> Response[BindResult | ErrorResponse]:
    """在另一个平台的私聊里使用绑定码：先预览要并到谁那里，同一个账号预览过之后带上 confirm
    再发才把这个平台账号的对象并进申请绑定码的对象。申请的对象标记了成员（这边没标记成同一个成员）时，还要那个成员在管理界面确认

    Args:
        body (BindRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[BindResult | ErrorResponse]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: BindRequest,
) -> BindResult | ErrorResponse | None:
    """在另一个平台的私聊里使用绑定码：先预览要并到谁那里，同一个账号预览过之后带上 confirm
    再发才把这个平台账号的对象并进申请绑定码的对象。申请的对象标记了成员（这边没标记成同一个成员）时，还要那个成员在管理界面确认

    Args:
        body (BindRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        BindResult | ErrorResponse
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
