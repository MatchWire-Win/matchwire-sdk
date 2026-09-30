"""Offline tests for the Python client — no network.

    cd python && python -m pytest tests/ -q      # or: python -m unittest
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from matchwire import Matchwire, MatchwireError, VENUES, TYPES, STATUSES  # noqa: E402


class FakeResponse:
    def __init__(self, body, status=200, headers=None):
        self._body = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.status = status
        self.headers = headers or {}
        self.code = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter([])


def patch_urlopen(handler):
    def fake(request, timeout=None):
        return handler(request)

    return mock.patch("urllib.request.urlopen", fake)


class VocabularyTests(unittest.TestCase):
    def test_exports(self):
        self.assertEqual(VENUES, ("kalshi", "poly", "polyintl", "predictfun"))
        self.assertIn("total", TYPES)
        self.assertEqual(STATUSES, ("scheduled", "live", "ended"))

    def test_missing_key_fails_fast(self):
        with self.assertRaises(MatchwireError) as ctx:
            Matchwire(api_key="")
        self.assertEqual(ctx.exception.code, "invalid_argument")


class RequestTests(unittest.TestCase):
    def test_rows_serialises_filters(self):
        seen = {}

        def handler(request):
            seen["url"] = request.full_url
            seen["key"] = request.get_header("X-api-key")
            return FakeResponse({"seq": 1, "rows": []})

        with patch_urlopen(handler):
            Matchwire(api_key="mw_test").rows(
                sport=["nfl", "nba"], venue="kalshi", type="winner,total", status="live", since=7
            )

        self.assertIn("sport=nfl%2Cnba", seen["url"])
        self.assertIn("venue=kalshi", seen["url"])
        self.assertIn("since=7", seen["url"])
        self.assertEqual(seen["key"], "mw_test")

    def test_unknown_vocabulary_is_rejected_before_the_request(self):
        client = Matchwire(api_key="mw_test")
        for kwargs in ({"venue": "betfair"}, {"type": "spread"}, {"status": "open"}):
            with self.assertRaises(MatchwireError) as ctx:
                client.rows(**kwargs)
            self.assertEqual(ctx.exception.code, "invalid_argument")

    def test_status_codes_map_to_typed_errors(self):
        import io
        import urllib.error

        def make(status, body):
            def handler(request):
                payload = io.BytesIO(json.dumps(body).encode())
                raise urllib.error.HTTPError(
                    request.full_url, status, "err", {"retry-after": "2"}, payload
                )

            return handler

        cases = [
            (401, lambda e: e.is_auth_error),
            (403, lambda e: e.is_plan_error),
            (429, lambda e: e.is_rate_limited and e.retry_after_ms == 2000.0),
            (404, lambda e: e.is_not_found),
        ]
        for status, predicate in cases:
            with patch_urlopen(make(status, {})):
                with self.assertRaises(MatchwireError) as ctx:
                    Matchwire(api_key="mw_test").rows()
            self.assertEqual(ctx.exception.status, status)
            self.assertTrue(predicate(ctx.exception), status)


class McpTests(unittest.TestCase):
    def test_sse_framed_json_is_unwrapped_and_get_row_is_a_convenience(self):
        def handler(request):
            payload = json.loads(request.data.decode())
            if payload["method"] == "tools/list":
                frame = {"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "list_sports"}]}}
            else:
                inner = {"row": {"id": "ev:nfl:a:b:2026-10-25"}}
                frame = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {"content": [{"type": "text", "text": json.dumps(inner)}]},
                }
            return FakeResponse("event: message\ndata: " + json.dumps(frame) + "\n\n")

        with patch_urlopen(handler):
            client = Matchwire(api_key="mw_test")
            self.assertEqual(client.tools()[0]["name"], "list_sports")
            self.assertEqual(client.mapping("ev:nfl:a:b:2026-10-25")["id"], "ev:nfl:a:b:2026-10-25")

    def test_tool_error_is_typed(self):
        def handler(request):
            return FakeResponse({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "unknown tool"}})

        with patch_urlopen(handler):
            with self.assertRaises(MatchwireError) as ctx:
                Matchwire(api_key="mw_test").call_tool("nope")
            self.assertIn("unknown tool", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
