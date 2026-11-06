from http import HTTPStatus
from typing import Any, cast
from urllib.parse import quote

import httpx

from ...client import AuthenticatedClient, Client
from ...types import Response, UNSET
from ... import errors

from ...models.error_response import ErrorResponse
from ...models.memory_children import MemoryChildren
from typing import cast


def _get_kwargs(
    *,
    of: str,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["of"] = of

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/memories/children",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> ErrorResponse | MemoryChildren | None:
    if response.status_code == 200:
        response_200 = MemoryChildren.from_dict(response.json())

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
) -> Response[ErrorResponse | MemoryChildren]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    of: str,
) -> Response[ErrorResponse | MemoryChildren]:
    """列出直接子节点：of 是开头（core、user、persona、app）或坐标前缀（如 user://projects、persona://default）

    Args:
        of (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorResponse | MemoryChildren]
    """

    kwargs = _get_kwargs(
        of=of,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    of: str,
) -> ErrorResponse | MemoryChildren | None:
    """列出直接子节点：of 是开头（core、user、persona、app）或坐标前缀（如 user://projects、persona://default）

    Args:
        of (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorResponse | MemoryChildren
    """

    return sync_detailed(
        client=client,
        of=of,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    of: str,
) -> Response[ErrorResponse | MemoryChildren]:
    """列出直接子节点：of 是开头（core、user、persona、app）或坐标前缀（如 user://projects、persona://default）

    Args:
        of (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ErrorResponse | MemoryChildren]
    """

    kwargs = _get_kwargs(
        of=of,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    of: str,
) -> ErrorResponse | MemoryChildren | None:
    """列出直接子节点：of 是开头（core、user、persona、app）或坐标前缀（如 user://projects、persona://default）

    Args:
        of (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ErrorResponse | MemoryChildren
    """

    return (
        await asyncio_detailed(
            client=client,
            of=of,
        )
    ).parsed
