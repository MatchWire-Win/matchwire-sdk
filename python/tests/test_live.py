"""Live tests against api.matchwire.win.

    MATCHWIRE_API_KEY=mw_live_... python -m unittest tests.test_live -v

Skipped when MATCHWIRE_API_KEY is not set.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from matchwire import Matchwire, MatchwireError  # noqa: E402

API_KEY = os.environ.get("MATCHWIRE_API_KEY")
skip = unittest.skipUnless(API_KEY, "set MATCHWIRE_API_KEY to run live tests")


@skip
class LiveTests(unittest.TestCase):
    def setUp(self):
        self.mw = Matchwire(api_key=API_KEY)

    def test_status(self):
        status = self.mw.status()
        self.assertEqual(status["service"], "crossmap")
        self.assertGreater(status["store"]["events"], 0)
        self.assertTrue(status["coverage"])

    def test_sports(self):
        payload = self.mw.sports()
        self.assertTrue(payload["sports"])
        self.assertTrue(payload.get("groups"), "group ids are what sport= also accepts")

    def test_rows(self):
        payload = self.mw.rows(sport="nfl", limit=5)
        self.assertGreater(payload["seq"], 0)
        self.assertTrue(payload["rows"])
        for row in payload["rows"]:
            self.assertTrue(row["id"].startswith("ev:"))
            for listing in row["listings"]:
                self.assertTrue(listing["marketId"])

    def test_row_by_id(self):
        row = self.mw.rows(sport="nfl", limit=1)["rows"][0]
        fetched = self.mw.row(row["id"])
        self.assertEqual(fetched["id"], row["id"])

    def test_tools(self):
        names = [tool["name"] for tool in self.mw.tools()]
        for expected in ("list_sports", "find_rows", "get_row", "get_venue_market", "service_status"):
            self.assertIn(expected, names)

    def test_bad_key_is_a_typed_401(self):
        with self.assertRaises(MatchwireError) as ctx:
            Matchwire(api_key="mw_definitely_not_a_key").rows(sport="nfl")
        self.assertEqual(ctx.exception.status, 401)
        self.assertTrue(ctx.exception.is_auth_error)


if __name__ == "__main__":
    unittest.main()
