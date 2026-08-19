#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import hain7_signal as hs  # noqa: E402


class Hain7SignalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.context = hs.read_json(SKILL_DIR / "examples" / "sample-context.json")
        cls.cohort = hs.read_json(SKILL_DIR / "examples" / "sample-cohort.json")
        events_path = SKILL_DIR / "examples" / "sample-session" / "events.jsonl"
        cls.events, cls.raw = hs.load_events(events_path)
        cls.meta = hs.read_json(SKILL_DIR / "examples" / "sample-session" / "session.meta.json")

    def fresh_analysis(self, cohort: dict | None = None, review: dict | None = None) -> dict:
        events = copy.deepcopy(self.events)
        return hs.assemble_analysis(
            events,
            self.raw,
            copy.deepcopy(self.meta),
            copy.deepcopy(self.context),
            copy.deepcopy(cohort),
            copy.deepcopy(review),
        )

    def test_sample_scores_all_axes_without_scoring_ai_prose(self) -> None:
        analysis = self.fresh_analysis(self.cohort)
        self.assertEqual(list(analysis["axes"]), list(hs.AXES))
        self.assertTrue(all(axis["score"] is not None for axis in analysis["axes"].values()))
        self.assertEqual(analysis["data_summary"]["prompt_turn_count"], 9)
        self.assertEqual(analysis["data_summary"]["response_turn_coverage"], 1.0)
        for axis in analysis["axes"].values():
            for marker in axis["markers"]:
                self.assertFalse(any(evidence_id.startswith("R") for evidence_id in marker["evidence_ids"]))

    def test_synthetic_same_condition_cohort_gate(self) -> None:
        analysis = self.fresh_analysis(self.cohort)
        peer = analysis["peer_comparison"]
        self.assertTrue(peer["available"])
        self.assertEqual(peer["n"], 36)
        self.assertFalse(peer["national_norm"])
        self.assertTrue(peer["synthetic"])
        self.assertIn("top_percent", peer["axes"]["VE"])
        self.assertGreaterEqual(peer["axes"]["VE"]["top_percent"], 3, "36명 표본을 상위 1%처럼 과도하게 정밀 표기하면 안 됨")

    def test_mismatched_cohort_is_withheld_not_guessed(self) -> None:
        cohort = copy.deepcopy(self.cohort)
        cohort["norm_key"]["task_version"] = "different-task"
        analysis = self.fresh_analysis(cohort)
        self.assertFalse(analysis["peer_comparison"]["available"])
        self.assertIn("일치하지", analysis["peer_comparison"]["reason"])

    def test_small_cohort_is_withheld(self) -> None:
        cohort = copy.deepcopy(self.cohort)
        cohort["records"] = cohort["records"][:29]
        analysis = self.fresh_analysis(cohort)
        self.assertFalse(analysis["peer_comparison"]["available"])
        self.assertEqual(analysis["peer_comparison"]["n"], 29)

    def test_under_14_real_data_fails_without_guardian_consent(self) -> None:
        context = copy.deepcopy(self.context)
        context["synthetic"] = False
        context["privacy"]["guardian_consent_verified"] = False
        context["privacy"]["guardian_consent_verified_at"] = None
        with self.assertRaisesRegex(hs.SignalError, "법정대리인"):
            hs.validate_context(context)

    def test_real_data_requires_pseudonymous_display_id_attestation(self) -> None:
        context = copy.deepcopy(self.context)
        context["synthetic"] = False
        context["participant"]["pseudonymous"] = False
        with self.assertRaisesRegex(hs.SignalError, "가명"):
            hs.validate_context(context)

    def test_real_data_review_covers_all_markers_and_matches_fingerprint(self) -> None:
        context = copy.deepcopy(self.context)
        context["synthetic"] = False
        context["privacy"].update(
            {
                "guardian_consent_verified": True,
                "guardian_consent_verified_at": "2026-08-18T10:00:00+09:00",
            }
        )
        hs.validate_context(context)
        events = copy.deepcopy(self.events)
        candidate = hs.assemble_analysis(events, self.raw, self.meta, context, None, None)
        review = {
            "schema_version": "1.0",
            "session_fingerprint": candidate["session_fingerprint"],
            "reviewer_type": "facilitator_assisted",
            "completed_at": "2026-08-19T12:00:00+09:00",
            "reviewed_marker_ids": list(hs.MARKER_TITLES),
            "overrides": [],
        }
        reviewed = hs.assemble_analysis(copy.deepcopy(self.events), self.raw, self.meta, context, None, review)
        self.assertEqual(reviewed["review"]["reviewed_marker_count"], 28)
        bad = copy.deepcopy(review)
        bad["session_fingerprint"] = "0" * 64
        with self.assertRaisesRegex(hs.SignalError, "fingerprint"):
            hs.assemble_analysis(copy.deepcopy(self.events), self.raw, self.meta, context, None, bad)

    def test_no_opportunity_is_na_not_zero(self) -> None:
        minimal = [
            {
                "type": "prompt",
                "turn_id": "one",
                "text": "버튼 하나 만들어줘",
                "_line": 1,
                "_evidence_id": "P01",
            }
        ]
        markers = hs.score_markers(minimal)
        self.assertIsNone(markers["CO3"]["score"])
        self.assertIsNone(markers["IT1"]["score"])
        self.assertIsNone(markers["OW2"]["score"])

    def test_cli_analysis_output_is_auditable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "analysis.json"
            code = hs.main(
                [
                    "--input",
                    str(SKILL_DIR / "examples" / "sample-session"),
                    "--context",
                    str(SKILL_DIR / "examples" / "sample-context.json"),
                    "--cohort",
                    str(SKILL_DIR / "examples" / "sample-cohort.json"),
                    "--analysis-output",
                    str(output),
                ]
            )
            self.assertEqual(code, 0)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["rubric_version"], hs.RUBRIC_VERSION)
            self.assertEqual(len(payload["evidence_index"]), len(self.events))
            self.assertEqual(payload["review"]["status"], "not_reviewed")


if __name__ == "__main__":
    unittest.main()
