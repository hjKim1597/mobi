import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "app/app/src/main/res/raw"
MANIFEST = ROOT / "app/e2e/action-wording-audio.json"
RETIRED = {
    "action_cancelled.wav",
    "action_decline.wav",
    "action_expired.wav",
}


class ActionAssetInventoryTest(unittest.TestCase):
    def test_retired_action_clips_are_not_shipped_or_listed(self):
        active = set(json.loads(MANIFEST.read_text())["clips"])
        shipped = {path.name for path in RAW.glob("action_*.wav")}
        self.assertTrue(RETIRED.isdisjoint(active))
        self.assertTrue(RETIRED.isdisjoint(shipped))


if __name__ == "__main__":
    unittest.main()
