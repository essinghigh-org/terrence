import json
import unittest
from pathlib import Path
from run import journal_valid, negative_exercised, native_output_valid, case_directory


def record(sequence, ident, method, phase, result=None, error=None):
    return {"sequence": sequence, "id": ident, "method": method, "phase": phase,
            "requestSha256": "a" * 64, "result": result, "error": error}


def encode(records):
    return b"".join(json.dumps(r).encode() + b"\n" for r in records)


class JournalOracleTest(unittest.TestCase):
    def setUp(self):
        self.records = [record(0, "setup", "Setup", "begin"), record(1, "setup", "Setup", "end"),
                        record(2, "evaluation", "EvaluateResource", "begin"), record(3, "evaluation", "EvaluateResource", "end", "ALLOW")]

    def test_complete_positive_control(self):
        self.assertTrue(journal_valid(encode(self.records)))

    def test_shutdown_disposition_cannot_complete_inflight_rpc(self):
        self.assertFalse(journal_valid(encode(self.records[:-1])))

    def test_missing_or_denied_or_crashed_never_positive(self):
        self.assertFalse(journal_valid(b""))
        for failure in ("policy aggregate denied or unknown", "evaluation RPC failed"):
            self.records[-1]["error"] = failure
            self.assertFalse(journal_valid(encode(self.records)))

    def test_truncation_gap_replay_and_tampering(self):
        self.assertFalse(journal_valid(encode(self.records)[:-1]))
        for key, value in (("sequence", 9), ("requestSha256", "b" * 64), ("id", "unknown"), ("method", "Unexpected"), ("result", "DENY")):
            changed = [dict(r) for r in self.records]
            changed[-1][key] = value
            self.assertFalse(journal_valid(encode(changed)), key)
        self.assertFalse(journal_valid(encode(self.records + self.records)))

    def test_setup_only_is_not_a_completed_policy_stage(self):
        self.assertFalse(journal_valid(encode(self.records[:2])))
        self.assertTrue(journal_valid(encode(self.records[:2]), require_resource=False))


class NegativeScenarioTest(unittest.TestCase):
    def test_unrelated_failure_is_not_a_qualified_denial_or_crash(self):
        for mode in ("deny", "crash", "setup-error", "hang"):
            self.assertFalse(negative_exercised(mode, b""))
        self.assertFalse(negative_exercised("deny", encode([
            record(0, "setup", "Setup", "begin"),
            record(1, "setup", "Setup", "end", error="Setup RPC failed")])))

    def test_intended_error_requires_matching_started_rpc(self):
        for mode, method, error in (("deny", "EvaluateResource", "policy aggregate denied or unknown"),
                                    ("crash", "EvaluateResource", "evaluation RPC failed"),
                                    ("setup-error", "Setup", "Setup RPC failed")):
            records = [record(0, "rpc", method, "begin"), record(1, "rpc", method, "end", error=error)]
            self.assertTrue(negative_exercised(mode, encode(records)))
            self.assertFalse(negative_exercised(mode, encode(records[1:])))
            records[1]["requestSha256"] = "b" * 64
            self.assertFalse(negative_exercised(mode, encode(records)))

    def test_no_execution_cases_require_empty_journal(self):
        for mode in ("missing", "gate-denied"):
            self.assertTrue(negative_exercised(mode, b""))
            self.assertFalse(negative_exercised(mode, encode([record(0, "setup", "Setup", "begin")])))


class NativeOutputTest(unittest.TestCase):
    def test_pinned_version_and_allow_events(self):
        events = [{"type": "version", "terraform": "1.17.1", "ui": "1.3"},
                  {"type": "policy_result", "result": "AllowResult"}]
        self.assertTrue(native_output_valid(encode(events)))
        self.assertFalse(native_output_valid(encode(events)[:-1]))
        events[0]["ui"] = "1.2"
        self.assertFalse(native_output_valid(encode(events)))

    def test_error_and_non_allow_events_reject(self):
        version = {"type": "version", "terraform": "1.17.1", "ui": "1.3"}
        for event in ({"type": "policy_result", "result": "DenyResult"},
                      {"type": "policy_result"}, {"type": "policy_unrecognized"}, version,
                      {"type": "policy_diagnostic", "policy_diagnostic": {"severity": "error"}},
                      {"type": "diagnostic", "diagnostic": {"severity": "error"}}):
            self.assertFalse(native_output_valid(encode([version, event])))


class SocketPathBudgetTest(unittest.TestCase):
    def test_long_case_name_and_maximum_temporary_suffix(self):
        root = Path("/tmp/tfi-12345678")
        base = case_directory(root, "setup-error-saved-apply")
        self.assertLessEqual(len(str(base / "t" / "plugin-4294967295")), 60)
        self.assertEqual(base, case_directory(root, "setup-error-saved-apply"))
        self.assertNotEqual(base, case_directory(root, "allow-plan"))


if __name__ == "__main__":
    unittest.main()
