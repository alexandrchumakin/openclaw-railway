import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "gcalcli-credential-check.py"
SPEC = importlib.util.spec_from_file_location("gcalcli_credential_check", MODULE_PATH)
CHECKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CHECKER)


class CredentialValidationTest(unittest.TestCase):
    NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)

    def credential(self, **overrides):
        data = {
            "_module": "oauth2client.client",
            "_class": "OAuth2Credentials",
            "access_token": "fixture-access",
            "client_id": "fixture-client",
            "client_secret": "fixture-secret",
            "refresh_token": "fixture-refresh",
            "token_expiry": "2026-07-13T01:00:00Z",
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

    def validate(self, data):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "oauth"
            path.write_text(json.dumps(data), encoding="utf-8")
            return CHECKER.validate(path, now=self.NOW)

    def test_rejects_credentials_marked_invalid(self):
        ok, message = self.validate(self.credential(invalid=True))

        self.assertFalse(ok)
        self.assertEqual(message, "Google marked the OAuth credential invalid")

    def test_rejects_missing_refresh_token(self):
        ok, message = self.validate(self.credential(refresh_token=None))

        self.assertFalse(ok)
        self.assertEqual(message, "credential is missing required OAuth fields")

    def test_rejects_expired_time_limited_refresh_token(self):
        ok, message = self.validate(
            self.credential(
                token_expiry="2026-06-18T08:12:41Z",
                token_response={
                    "expires_in": 3600,
                    "refresh_token_expires_in": 604799,
                },
            )
        )

        self.assertFalse(ok)
        self.assertEqual(message, "OAuth refresh token has expired")

    def test_rejects_unexpired_time_limited_refresh_token(self):
        ok, message = self.validate(
            self.credential(
                token_expiry="2026-07-13T01:00:00Z",
                token_response={
                    "expires_in": 3600,
                    "refresh_token_expires_in": 604800,
                },
            )
        )

        self.assertFalse(ok)
        self.assertIn("refresh token is time-limited until", message)
        self.assertIn("replace it with non-time-limited authorization", message)

    def test_accepts_refresh_token_without_expiration_metadata(self):
        ok, message = self.validate(
            self.credential(token_response={})
        )

        self.assertTrue(ok)
        self.assertEqual(message, "refresh token is valid")

    def test_structure_only_accepts_well_formed_invalid_credentials(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "oauth"
            path.write_text(json.dumps(self.credential(invalid=True)), encoding="utf-8")

            ok, message = CHECKER.validate(path, structure_only=True)

        self.assertTrue(ok)
        self.assertEqual(message, "credential structure is valid")

    def test_rejects_arbitrary_json_with_only_a_refresh_token(self):
        ok, message = self.validate({"refresh_token": "fixture"})

        self.assertFalse(ok)
        self.assertEqual(message, "credential is not an oauth2client OAuth2Credentials object")

    def test_rejects_credentials_without_google_calendar_scope(self):
        ok, message = self.validate(self.credential(scopes=[]))

        self.assertFalse(ok)
        self.assertEqual(message, "credential is missing the required Google Calendar scope")


if __name__ == "__main__":
    unittest.main()
