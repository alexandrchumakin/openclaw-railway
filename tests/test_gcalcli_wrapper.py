import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
WRAPPER = ROOT / "gcalcli-wrapper.sh"
CHECKER = ROOT / "gcalcli-credential-check.py"


@unittest.skipUnless(
    shutil.which("flock") and shutil.which("timeout"),
    "requires Linux flock and timeout commands",
)
class GcalcliWrapperTest(unittest.TestCase):
    def environment(self, tmpdir: str) -> dict[str, str]:
        root = Path(tmpdir)
        return {
            **os.environ,
            "GCALCLI_STATE_DIR": str(root / "state"),
            "GCALCLI_STATE_FILE": str(root / "state" / "oauth"),
            "GCALCLI_RUNTIME_FILE": str(root / "runtime-oauth"),
            "GCALCLI_CREDENTIAL_CHECKER": str(CHECKER),
            "GCALCLI_COMMAND_TIMEOUT_SECONDS": "1",
        }

    def write_valid_credential(self, env: dict[str, str]) -> None:
        path = Path(env["GCALCLI_STATE_FILE"])
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps(self.credential()),
            encoding="utf-8",
        )

    def credential(self, **overrides):
        data = {
            "_module": "oauth2client.client",
            "_class": "OAuth2Credentials",
            "access_token": "fixture-access",
            "client_id": "fixture-client",
            "client_secret": "fixture-secret",
            "refresh_token": "fixture-refresh",
            "token_expiry": "2030-01-01T00:00:00Z",
            "token_uri": "https://oauth2.googleapis.com/token",
            "user_agent": None,
            "revoke_uri": "https://oauth2.googleapis.com/revoke",
            "id_token": None,
            "token_response": {},
            "scopes": ["https://www.googleapis.com/auth/calendar"],
            "token_info_uri": None,
            "id_token_jwt": None,
            "invalid": False,
        }
        data.update(overrides)
        return data

    def test_invalid_credentials_fail_before_running_gcalcli(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            env["GCALCLI_REAL_BIN"] = "/bin/true"

            result = subprocess.run(
                ["sh", str(WRAPPER), "agenda"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 78)
            self.assertIn("calendar authentication unavailable", result.stderr)

    def test_valid_credentials_run_command_and_sync_runtime_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            env["GCALCLI_REAL_BIN"] = "/bin/true"
            self.write_valid_credential(env)

            result = subprocess.run(
                ["sh", str(WRAPPER), "agenda"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0)
            self.assertTrue(Path(env["GCALCLI_RUNTIME_FILE"]).is_file())

    def test_hung_gcalcli_is_terminated_at_the_inner_timeout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            self.write_valid_credential(env)
            fake_gcalcli = Path(tmpdir) / "fake-gcalcli"
            fake_gcalcli.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
            fake_gcalcli.chmod(0o755)
            env["GCALCLI_REAL_BIN"] = str(fake_gcalcli)

            started = time.monotonic()
            result = subprocess.run(
                ["sh", str(WRAPPER), "agenda"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 124)
            self.assertLess(time.monotonic() - started, 3)
            self.assertIn("command timed out after 1s", result.stderr)

    def test_malformed_runtime_state_does_not_replace_persisted_credentials(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            self.write_valid_credential(env)
            original = Path(env["GCALCLI_STATE_FILE"]).read_text(encoding="utf-8")
            fake_gcalcli = Path(tmpdir) / "fake-gcalcli"
            fake_gcalcli.write_text(
                '#!/bin/sh\nprintf "%s" "{}" > "$GCALCLI_RUNTIME_FILE"\nexit 1\n',
                encoding="utf-8",
            )
            fake_gcalcli.chmod(0o755)
            env["GCALCLI_REAL_BIN"] = str(fake_gcalcli)

            result = subprocess.run(
                ["sh", str(WRAPPER), "agenda"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(
                Path(env["GCALCLI_STATE_FILE"]).read_text(encoding="utf-8"),
                original,
            )
            self.assertIn("refreshed OAuth state was not persisted", result.stderr)

    def test_well_formed_invalid_runtime_state_is_persisted_for_fast_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            self.write_valid_credential(env)
            next_credential = Path(tmpdir) / "next-credential"
            next_credential.write_text(
                json.dumps(self.credential(invalid=True)),
                encoding="utf-8",
            )
            env["NEXT_CREDENTIAL"] = str(next_credential)
            fake_gcalcli = Path(tmpdir) / "fake-gcalcli"
            fake_gcalcli.write_text(
                '#!/bin/sh\ncp "$NEXT_CREDENTIAL" "$GCALCLI_RUNTIME_FILE"\nexit 1\n',
                encoding="utf-8",
            )
            fake_gcalcli.chmod(0o755)
            env["GCALCLI_REAL_BIN"] = str(fake_gcalcli)

            result = subprocess.run(
                ["sh", str(WRAPPER), "agenda"],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            persisted = json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text(encoding="utf-8"))
            self.assertTrue(persisted["invalid"])

    def test_malformed_newer_runtime_file_recovers_on_every_command(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            env["GCALCLI_REAL_BIN"] = "/bin/true"
            self.write_valid_credential(env)
            runtime_path = Path(env["GCALCLI_RUNTIME_FILE"])
            runtime_path.write_text("{}", encoding="utf-8")
            future = time.time() + 60
            os.utime(runtime_path, (future, future))

            for _ in range(2):
                result = subprocess.run(
                    ["sh", str(WRAPPER), "agenda"],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    json.loads(runtime_path.read_text(encoding="utf-8")),
                    self.credential(),
                )


if __name__ == "__main__":
    unittest.main()
