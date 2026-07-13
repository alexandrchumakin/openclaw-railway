import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
PREPARE = ROOT / "prepare-gcalcli-credentials.sh"
CHECKER = ROOT / "gcalcli-credential-check.py"
WRAPPER = ROOT / "gcalcli-wrapper.sh"


@unittest.skipUnless(sys.platform.startswith("linux"), "requires GNU base64 and Linux tools")
class PrepareGcalcliCredentialsTest(unittest.TestCase):
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

    def environment(self, tmpdir: str) -> dict[str, str]:
        root = Path(tmpdir)
        return {
            **os.environ,
            "GCALCLI_STATE_DIR": str(root / "state"),
            "GCALCLI_STATE_FILE": str(root / "state" / "oauth"),
            "GCALCLI_RUNTIME_FILE": str(root / "runtime-oauth"),
            "GCALCLI_CREDENTIAL_CHECKER": str(CHECKER),
            "GCALCLI_LIVE_PROBE": "0",
            "GCALCLI_STATUS_FILE": str(root / "state" / "status"),
        }

    def write_state(self, env: dict[str, str], credential: dict) -> None:
        path = Path(env["GCALCLI_STATE_FILE"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(credential), encoding="utf-8")

    def encode(self, credential: dict) -> str:
        return base64.b64encode(json.dumps(credential).encode()).decode()

    def run_prepare(self, env: dict[str, str]):
        result = subprocess.run(
            ["sh", str(PREPARE)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("fixture-access", result.stdout + result.stderr)
        self.assertNotIn("fixture-refresh", result.stdout + result.stderr)
        return result

    def test_usable_volume_state_is_preserved_over_environment_value(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            state = self.credential()
            self.write_state(env, state)
            env["GCALCLI_OAUTH_BASE64"] = "not-valid-base64"

            result = self.run_prepare(env)

            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), state)
            self.assertEqual(json.loads(Path(env["GCALCLI_RUNTIME_FILE"]).read_text()), state)
            self.assertIn("Keeping persisted", result.stdout)
            self.assertEqual(Path(env["GCALCLI_STATE_DIR"]).stat().st_mode & 0o777, 0o700)
            self.assertEqual(Path(env["GCALCLI_STATE_FILE"]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(env["GCALCLI_STATUS_FILE"]).read_text().strip(), "unchecked")

    def test_valid_environment_credential_atomically_replaces_invalid_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            self.write_state(env, self.credential(invalid=True))
            replacement = self.credential(access_token="replacement-access")
            env["GCALCLI_OAUTH_BASE64"] = self.encode(replacement)

            result = self.run_prepare(env)

            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), replacement)
            self.assertEqual(json.loads(Path(env["GCALCLI_RUNTIME_FILE"]).read_text()), replacement)
            self.assertIn("Imported gcalcli OAuth credentials", result.stdout)

    def test_invalid_environment_value_does_not_destroy_existing_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            invalid_state = self.credential(invalid=True)
            self.write_state(env, invalid_state)
            env["GCALCLI_OAUTH_BASE64"] = base64.b64encode(b"{}").decode()

            result = self.run_prepare(env)

            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), invalid_state)
            self.assertFalse(Path(env["GCALCLI_RUNTIME_FILE"]).exists())
            self.assertIn("OAuth import rejected", result.stdout)

    def test_forced_invalid_import_preserves_usable_volume_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            state = self.credential()
            self.write_state(env, state)
            env["GCALCLI_FORCE_IMPORT"] = "1"
            env["GCALCLI_OAUTH_BASE64"] = base64.b64encode(b"{}").decode()

            self.run_prepare(env)

            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), state)
            self.assertEqual(json.loads(Path(env["GCALCLI_RUNTIME_FILE"]).read_text()), state)

    def test_force_import_zero_preserves_usable_volume_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            state = self.credential()
            self.write_state(env, state)
            env["GCALCLI_FORCE_IMPORT"] = "0"
            env["GCALCLI_OAUTH_BASE64"] = base64.b64encode(b"{}").decode()

            result = self.run_prepare(env)

            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), state)
            self.assertIn("Keeping persisted", result.stdout)

    def test_dual_environment_credentials_fail_without_overwriting_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            state = self.credential()
            self.write_state(env, state)
            env["GCALCLI_OAUTH_BASE64"] = self.encode(state)
            env["GCALCLI_OAUTH_JSON"] = json.dumps(state)

            result = subprocess.run(
                ["sh", str(PREPARE)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 64)
            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), state)
            self.assertIn("set only GCALCLI_OAUTH_BASE64", result.stderr)

    def test_transient_live_probe_failure_keeps_usable_credentials(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            state = self.credential()
            self.write_state(env, state)
            fake_gcalcli = Path(tmpdir) / "fake-gcalcli"
            fake_gcalcli.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            fake_gcalcli.chmod(0o755)
            env["GCALCLI_GCALCLI_BIN"] = str(fake_gcalcli)
            env["GCALCLI_LIVE_PROBE"] = "1"

            result = self.run_prepare(env)

            self.assertTrue(Path(env["GCALCLI_RUNTIME_FILE"]).exists())
            self.assertEqual(json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text()), state)
            self.assertIn("live Calendar probe failed", result.stdout)

    def test_auth_failure_during_live_probe_persists_invalid_state_and_removes_runtime(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env = self.environment(tmpdir)
            self.write_state(env, self.credential())
            invalid_credential = Path(tmpdir) / "invalid-credential"
            invalid_credential.write_text(
                json.dumps(self.credential(invalid=True)),
                encoding="utf-8",
            )
            fake_real = Path(tmpdir) / "fake-real-gcalcli"
            fake_real.write_text(
                '#!/bin/sh\ncp "$NEXT_CREDENTIAL" "$GCALCLI_RUNTIME_FILE"\nexit 1\n',
                encoding="utf-8",
            )
            fake_real.chmod(0o755)
            wrapper_launcher = Path(tmpdir) / "gcalcli"
            wrapper_launcher.write_text(
                f'#!/bin/sh\nexec sh "{WRAPPER}" "$@"\n',
                encoding="utf-8",
            )
            wrapper_launcher.chmod(0o755)
            env.update({
                "GCALCLI_GCALCLI_BIN": str(wrapper_launcher),
                "GCALCLI_REAL_BIN": str(fake_real),
                "GCALCLI_LIVE_PROBE": "1",
                "NEXT_CREDENTIAL": str(invalid_credential),
            })

            result = self.run_prepare(env)

            persisted = json.loads(Path(env["GCALCLI_STATE_FILE"]).read_text())
            self.assertTrue(persisted["invalid"])
            self.assertFalse(Path(env["GCALCLI_RUNTIME_FILE"]).exists())
            self.assertIn("credentials became unavailable", result.stdout)


if __name__ == "__main__":
    unittest.main()
