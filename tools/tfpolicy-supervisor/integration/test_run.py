import json
import unittest
from run import journal_valid


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


if __name__ == "__main__":
    unittest.main()
