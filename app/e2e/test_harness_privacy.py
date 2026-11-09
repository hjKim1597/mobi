"""Host-only regressions: command failures must not persist private arguments/output."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("mobi_harness", Path(__file__).with_name("run.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class HarnessPrivacyTest(unittest.TestCase):
    def test_tracked_signing_password_key_fails_without_disclosing_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = "PRIVATE_PROPERTY_VALUE_FIXTURE"
            (root / "gradle.properties").write_text("mobiReleaseStorePassword=" + marker + "\n")
            with patch.object(harness, "ROOT", root), patch.object(harness, "run", return_value=b"gradle.properties\0"):
                with self.assertRaises(AssertionError) as failure:
                    harness.verify_tracked_signing_properties()
            self.assertIn("mobiReleaseStorePassword", str(failure.exception))
            self.assertNotIn(marker, str(failure.exception))

    def test_password_key_colon_and_whitespace_separators_fail(self):
        for line in ("mobiReleaseKeyPassword : PRIVATE_FIXTURE", "mobiReleaseOtherPassword PRIVATE_FIXTURE"):
            with self.subTest(line=line), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "gradle.properties").write_text(line)
                with patch.object(harness, "ROOT", root), patch.object(harness, "run", return_value=b"gradle.properties\0"):
                    with self.assertRaises(AssertionError) as failure:
                        harness.verify_tracked_signing_properties()
                self.assertNotIn("PRIVATE_FIXTURE", str(failure.exception))

    def test_comments_and_untracked_private_properties_are_not_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gradle.properties").write_text("# mobiReleaseStorePassword=example\n! mobiReleaseKeyPassword=example\norg.gradle.jvmargs=-Xmx2g\n")
            (root / "private.properties").write_text("mobiReleaseStorePassword=PRIVATE_FIXTURE\n")
            with patch.object(harness, "ROOT", root), patch.object(harness, "run", return_value=b"gradle.properties\0"):
                self.assertEqual(1, harness.verify_tracked_signing_properties())

    def test_failed_command_omits_arguments_and_stdout_stderr(self):
        marker = "PRIVATE_TRANSCRIPT_TOKEN_DEVICE_FIXTURE"
        with self.assertRaises(RuntimeError) as failure:
            harness.run([sys.executable, "-c", "import sys; print(sys.argv[1]); print(sys.argv[1], file=sys.stderr); sys.exit(23)", marker])
        self.assertNotIn(marker, str(failure.exception))
        self.assertNotIn("sys.argv", str(failure.exception))
        self.assertIn("23", str(failure.exception))

    def test_timeout_omits_private_command_arguments(self):
        marker = "PRIVATE_CALENDAR_FIXTURE"
        with self.assertRaises(RuntimeError) as failure:
            harness.run([sys.executable, "-c", "import time; time.sleep(1)", marker], timeout=.05)
        self.assertNotIn(marker, str(failure.exception))
        self.assertIn("timed out", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
