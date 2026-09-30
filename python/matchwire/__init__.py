"""matchwire.win — mapped prediction-market data for Python.

One row per game, matched across Kalshi, Polymarket US, Polymarket International
and Predict.fun, each venue's own market id left intact. Mapping only: no prices.

    from matchwire import Matchwire

    mw = Matchwire(api_key="mw_live_...")
    rows = mw.rows(sport="nfl", venue=["kalshi", "poly"])["rows"]
    print(rows[0]["name"], [l["venue"] for l in rows[0]["listings"]])

Standard library only. Docs: https://matchwire.win/docs/
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, Iterator, List, Optional, Union

__version__ = "0.1.0"

DEFAULT_BASE_URL = "https://api.matchwire.win"
VENUES = ("kalshi", "poly", "polyintl", "predictfun")
TYPES = ("winner", "total", "handicap", "map_winner", "score", "event")
STATUSES = ("scheduled", "live", "ended")
DEFAULT_TIMEOUT = 20.0
DEFAULT_USER_AGENT = f"matchwire.win-python/{__version__}"


class MatchwireError(Exception):
    """Raised for a non-2xx response, a transport failure or an invalid argument."""

    def __init__(
        self,
        message: str,
        status: int = 0,
        code: str = "unknown_error",
        body: Any = None,
        retry_after_ms: Optional[float] = None,
        url: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body
        self.retry_after_ms = retry_after_ms
        self.url = url

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429

    @property
    def is_auth_error(self) -> bool:
        return self.status == 401

    @property
    def is_plan_error(self) -> bool:
        return self.status == 403

    @property
    def is_not_found(self) -> bool:
        return self.status == 404

    @property
    def is_retryable(self) -> bool:
        return self.status == 0 or self.status == 429 or self.status >= 500


def _clean(params: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key, value in params.items():
        if value is None or value == "":
            continue
        if isinstance(value, (list, tuple, set)):
            items = [str(v) for v in value]
            if not items:
                continue
            out[key] = ",".join(items)
        elif isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = str(value)
    return out


def _check_vocab(name: str, value: Any, allowed: Iterable[str]) -> None:
    if value is None:
        return
    values = value if isinstance(value, (list, tuple, set)) else str(value).split(",")
    allowed = tuple(allowed)
    for item in values:
        if item not in allowed:
            raise MatchwireError(
                f"invalid {name}: {item!r} — expected one of {', '.join(allowed)}",
                code="invalid_argument",
            )


class Matchwire:
    """Client for the matchwire.win HTTP API and its MCP endpoint.

    :param api_key: key from https://matchwire.win/#pricing (mw_...). Required.
    :param base_url: defaults to https://api.matchwire.win
    :param timeout: per-request timeout in seconds, default 20.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not api_key or not isinstance(api_key, str):
            raise MatchwireError(
                "api_key is required — get one at https://matchwire.win",
                code="invalid_argument",
            )
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # -- transport ---------------------------------------------------------

    def _request(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        method: str = "GET",
        payload: Any = None,
    ) -> Any:
        query = _clean(params or {})
        url = self.base_url + path + (("?" + urllib.parse.urlencode(query)) if query else "")
        data = None
        headers = {
            "x-api-key": self.api_key,
            "accept": "application/json",
            # The API sits behind Cloudflare, which returns 1010 for a default
            # urllib signature; name the client so requests are identified.
            "user-agent": DEFAULT_USER_AGENT,
        }
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["content-type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            body: Any = None
            if text:
                try:
                    body = json.loads(text)
                except ValueError:
                    match = _sse_data(text)
                    body = match if match is not None else text
            code = body.get("error") if isinstance(body, dict) else None
            retry_after = error.headers.get("retry-after")
            raise MatchwireError(
                f"{error.code} {code or ''}".strip(),
                status=error.code,
                code=code or f"http_{error.code}",
                body=body,
                retry_after_ms=(float(retry_after) * 1000 if retry_after else _retry_ms(body)),
                url=url,
            ) from None
        except urllib.error.URLError as error:
            raise MatchwireError(
                f"request failed: {error.reason}", code="network_error", url=url
            ) from None
        except TimeoutError:
            raise MatchwireError(
                f"request timed out after {self.timeout}s", code="network_error", url=url
            ) from None

        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            parsed = _sse_data(text)
            return parsed if parsed is not None else text

    # -- REST --------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        """Service and per-venue health, the current seq, and coverage counts."""
        return self._request("/api/v1/status")

    def sports(self) -> Dict[str, Any]:
        """Sports with game counts, plus the group ids ``sport=`` also accepts."""
        return self._request("/api/v1/sports")

    def rows(self, **params: Any) -> Dict[str, Any]:
        """One row per game with its per-venue listings.

        Filters: ``sport``, ``venue``, ``type``, ``league``, ``status`` (a value
        or a comma list), ``since=<seq>`` for a delta, ``limit`` up to 5000.
        """
        _check_vocab("venue", params.get("venue"), VENUES)
        _check_vocab("type", params.get("type"), TYPES)
        _check_vocab("status", params.get("status"), STATUSES)
        return self._request("/api/v1/rows", params)

    def mapping(self, row_id: str) -> Dict[str, Any]:
        """One game by the mapped id handed out in :meth:`rows`.

        Served by the MCP ``get_row`` tool, because the REST API exposes games
        as a set. Alias: :meth:`row`.
        """
        if not row_id or not isinstance(row_id, str):
            raise MatchwireError("mapping(id) needs a mapped id from rows()", code="invalid_argument")
        result = self.call_tool("get_row", {"id": row_id})
        if isinstance(result, dict) and "row" in result:
            return result["row"]
        return result

    # British spelling and the shorter name, for muscle memory.
    row = mapping

    def stream(self, **params: Any) -> Iterator[Dict[str, Any]]:
        """Yield the same updates as ``rows(since=...)`` over Server-Sent Events.

        Each item is ``{"event": str, "data": Any, "id": str | None}``.
        """
        query = _clean(params)
        url = self.base_url + "/api/v1/push" + (("?" + urllib.parse.urlencode(query)) if query else "")
        request = urllib.request.Request(
            url,
            headers={
                "x-api-key": self.api_key,
                "accept": "text/event-stream",
                "user-agent": DEFAULT_USER_AGENT,
            },
        )
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8", "replace")
            raise MatchwireError(
                f"{error.code} on the stream",
                status=error.code,
                code=f"http_{error.code}",
                body=text or None,
                url=url,
            ) from None

        with response:
            event, event_id, pending = "message", None, None
            for raw_line in response:
                line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
                if line == "":
                    if pending is not None:
                        yield {"event": event, "data": pending, "id": event_id}
                        pending = None
                    event, event_id = "message", None
                    continue
                if line.startswith(":"):
                    continue
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    event = value
                elif field == "id":
                    event_id = value
                elif field == "data":
                    try:
                        pending = json.loads(value)
                    except ValueError:
                        pending = value

    # -- MCP ---------------------------------------------------------------

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """Call any MCP tool the endpoint advertises, over the same endpoint an agent uses."""
        response = self._request(
            "/mcp",
            method="POST",
            payload={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
        )
        if isinstance(response, dict) and response.get("error"):
            error = response["error"]
            raise MatchwireError(
                f"mcp error: {error.get('message')}",
                code=str(error.get("code") or "mcp_error"),
                body=response,
            )
        result = (response or {}).get("result") or {}
        content = result.get("content") or []
        if content and isinstance(content[0], dict) and "text" in content[0]:
            try:
                return json.loads(content[0]["text"])
            except ValueError:
                return content[0]["text"]
        return result

    def tools(self) -> List[Dict[str, Any]]:
        """The tools the MCP endpoint advertises."""
        response = self._request(
            "/mcp", method="POST", payload={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        return ((response or {}).get("result") or {}).get("tools", [])


def _sse_data(text: str) -> Any:
    for line in text.splitlines():
        if line.startswith("data: "):
            try:
                return json.loads(line[6:])
            except ValueError:
                continue
    return None


def _retry_ms(body: Any) -> Optional[float]:
    if isinstance(body, dict) and body.get("retry_after_ms") is not None:
        return float(body["retry_after_ms"])
    return None


__all__ = [
    "Matchwire",
    "MatchwireError",
    "DEFAULT_BASE_URL",
    "VENUES",
    "TYPES",
    "STATUSES",
    "__version__",
]
