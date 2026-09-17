from __future__ import annotations

import unittest
from pathlib import Path

from protocol_parser import ProtocolError, parse_output


FIXTURES = Path(__file__).with_name("data")


class ProtocolParserTests(unittest.TestCase):
    def test_complete_fixture(self) -> None:
        parsed = parse_output((FIXTURES / "complete.log").read_text())
        self.assertEqual(parsed.terminal["event"], "complete")
        self.assertEqual(len(parsed.measurements), 1)
        self.assertEqual(
            parsed.measurements[0]["metrics"]["guest_insn_dispatched"], 18
        )

    def test_error_fixture(self) -> None:
        parsed = parse_output((FIXTURES / "error.log").read_text())
        self.assertEqual(parsed.terminal["event"], "error")
        self.assertEqual(parsed.terminal["code"], "missing_end")

    def test_rejects_malformed_prefixed_json(self) -> None:
        with self.assertRaises(ProtocolError):
            parse_output((FIXTURES / "malformed.log").read_text())

    def test_requires_terminal_to_be_last(self) -> None:
        complete = (FIXTURES / "complete.log").read_text()
        measurement = complete.splitlines()[1]
        with self.assertRaises(ProtocolError):
            parse_output(complete + measurement + "\n")


if __name__ == "__main__":
    unittest.main()
