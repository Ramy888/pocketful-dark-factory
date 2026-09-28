"""Tests for the seat watchdog. Run: python3 -m unittest discover -s factory/lint"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
WATCHDOG = HERE.parent / "bin" / "watchdog"

spec = importlib.util.spec_from_loader(
    "watchdog", importlib.machinery.SourceFileLoader("watchdog", str(WATCHDOG))
)
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)

INBOX_QUEUED = (
    "[11111111-2222-3333-4444-555555555555] bbbbbbbb-1111-2222-3333-444444444444 "
    "from ramy.comm/coordinator: @ramy.comm/implementer Assignment: board #3\n"
)
ACTIVITY = (
    "2026-09-19 23:22 default/factory-implementer sess room turn_ended \n"
    "2026-09-19 23:21 default/factory-implementer sess room tool_call_ended Bash\n"
)


class Parsing(unittest.TestCase):
    def test_empty_inbox(self):
        self.assertEqual(watchdog.parse_inbox("(inbox empty)\n"), [])

    def test_queued_message_id(self):
        self.assertEqual(
            watchdog.parse_inbox(INBOX_QUEUED),
            ["bbbbbbbb-1111-2222-3333-444444444444"],
        )

    def test_last_activity(self):
        self.assertEqual(
            watchdog.parse_last_activity(ACTIVITY), datetime(2026, 9, 19, 23, 22)
        )

    def test_no_activity(self):
        self.assertIsNone(watchdog.parse_last_activity("\n"))


class Decision(unittest.TestCase):
    now = datetime(2026, 9, 19, 23, 30)

    def test_idle_with_queued_message_is_stalled(self):
        self.assertTrue(
            watchdog.is_stalled(["m1"], self.now - timedelta(minutes=9), self.now, 300)
        )

    def test_recent_activity_is_working(self):
        self.assertFalse(
            watchdog.is_stalled(["m1"], self.now - timedelta(seconds=30), self.now, 300)
        )

    def test_empty_inbox_is_never_stalled(self):
        self.assertFalse(
            watchdog.is_stalled([], self.now - timedelta(hours=2), self.now, 300)
        )

    def test_queued_message_and_no_activity_at_all_is_stalled(self):
        self.assertTrue(watchdog.is_stalled(["m1"], None, self.now, 300))


class EndToEnd(unittest.TestCase):
    def _stub(self, tmp, activity, inbox=None):
        """A fake jam that reports one queued message and the given activity."""
        stub = Path(tmp) / "jam"
        stub.write_text(
            "#!/bin/sh\n"
            'for a in "$@"; do\n'
            '  case "$a" in\n'
            f'    inbox) printf %s "{inbox or INBOX_QUEUED}"; exit 0 ;;\n'
            f'    list) printf %s "{activity}"; exit 0 ;;\n'
            '    restart) echo "$@" >> "$STUB_LOG"; exit 0 ;;\n'
            "  esac\n"
            "done\n"
        )
        stub.chmod(0o755)
        return stub

    def _run(self, activity, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            proc, calls, _ = self._run_in(tmp, activity, *extra)
            return proc, calls

    def _run_in(self, tmp, activity, *extra, inbox=None):
        log = Path(tmp) / "calls.log"
        stub = self._stub(tmp, activity, inbox)
        env = {**os.environ, "STUB_LOG": str(log), "JAM": str(stub)}
        proc = subprocess.run(
            [sys.executable, str(WATCHDOG), "--once", "--roles", "implementer",
             "--idle-seconds", "300", "--state", str(Path(tmp) / "state.json"), *extra],
            capture_output=True, text=True, env=env,
        )
        calls = log.read_text() if log.exists() else ""
        return proc, calls, log

    def test_restarts_a_stalled_seat(self):
        stale = "2020-01-01 00:00 default/factory-implementer s r turn_ended \n"
        proc, calls = self._run(stale)
        self.assertIn("restart", calls, proc.stdout + proc.stderr)
        self.assertIn("implementer", proc.stdout)

    def test_leaves_a_working_seat_alone(self):
        fresh = datetime.now().strftime("%Y-%m-%d %H:%M") + \
            " default/factory-implementer s r tool_call_started Bash\n"
        proc, calls = self._run(fresh)
        self.assertEqual(calls, "", proc.stdout)

    def test_dry_run_reports_without_restarting(self):
        stale = "2020-01-01 00:00 default/factory-implementer s r turn_ended \n"
        proc, calls = self._run(stale, "--dry-run")
        self.assertEqual(calls, "")
        self.assertIn("would restart", proc.stdout.lower())


STALE = "2020-01-01 00:00 default/factory-implementer s r turn_ended \n"
OTHER_INBOX = (
    "[11111111-2222-3333-4444-555555555555] aaaaaaaa-1111-2222-3333-444444444444 "
    "from ramy.comm/coordinator: @ramy.comm/implementer Assignment: board #9\n"
)


class SessionPrefix(unittest.TestCase):
    """The prefix must reach the seat, or the watchdog watches nothing and says so cheerfully.

    create-seats takes SEAT_PREFIX so a run can have its own seats without overwriting
    another run's. A watchdog that still looked for `factory-<role>` would find an empty
    inbox for every seat, report all of them healthy, and let a real stall run silently --
    which is the one failure it exists to catch.
    """

    def test_default_prefix_is_factory(self):
        stale = "2020-01-01 00:00 default/factory-implementer s r turn_ended \n"
        proc, calls = EndToEnd()._run(stale)
        self.assertIn("--session factory-implementer", calls, proc.stdout + proc.stderr)

    def test_prefix_reaches_the_restart(self):
        stale = "2020-01-01 00:00 default/pocketful-implementer s r turn_ended \n"
        proc, calls = EndToEnd()._run(stale, "--prefix", "pocketful")
        self.assertIn("--session pocketful-implementer", calls, proc.stdout + proc.stderr)
        self.assertNotIn("factory-implementer", calls)


class RestartLoop(unittest.TestCase):
    """A restart cannot fix a usage limit or a dead provider: stop and say so."""

    def test_gives_up_after_max_restarts_and_alerts(self):
        with tempfile.TemporaryDirectory() as tmp:
            for _ in range(2):
                self._run_in(tmp, STALE, "--max-restarts", "2")
            proc, calls, _ = self._run_in(tmp, STALE, "--max-restarts", "2")
            self.assertEqual(calls.count("restart"), 2, calls)
            self.assertIn("ALERT", proc.stdout)

    def test_new_queued_work_resets_the_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            for _ in range(3):
                self._run_in(tmp, STALE, "--max-restarts", "1")
            proc, calls, _ = self._run_in(tmp, STALE, "--max-restarts", "1",
                                          inbox=OTHER_INBOX)
            self.assertEqual(calls.count("restart"), 2, calls)
            self.assertNotIn("ALERT", proc.stdout)

    _stub = EndToEnd._stub
    _run_in = EndToEnd._run_in


if __name__ == "__main__":
    unittest.main()
