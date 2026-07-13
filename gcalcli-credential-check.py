#!/usr/bin/env python3
"""Validate gcalcli oauth2client credentials without exposing token data."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_credential(path: Path) -> tuple[dict | None, str | None]:
    if not path.is_file():
        return None, "credential file is missing"

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, "credential file is not valid JSON"

    if not isinstance(data, dict):
        return None, "credential JSON is not an object"

    if data.get("_module") != "oauth2client.client" or data.get("_class") != "OAuth2Credentials":
        return None, "credential is not an oauth2client OAuth2Credentials object"

    required_strings = (
        "access_token",
        "client_id",
        "client_secret",
        "refresh_token",
        "token_uri",
    )
    if any(not isinstance(data.get(field), str) or not data[field] for field in required_strings):
        return None, "credential is missing required OAuth fields"

    scopes = data.get("scopes")
    if isinstance(scopes, str):
        scopes = scopes.split()
    if not isinstance(scopes, list) or "https://www.googleapis.com/auth/calendar" not in scopes:
        return None, "credential is missing the required Google Calendar scope"

    try:
        from oauth2client.client import Credentials
    except ImportError:
        pass
    else:
        try:
            Credentials.new_from_json(json.dumps(data))
        except Exception:
            return None, "oauth2client cannot deserialize the credential"

    return data, None


def validate(
    path: Path,
    now: datetime | None = None,
    *,
    structure_only: bool = False,
    allow_time_limited: bool = False,
) -> tuple[bool, str]:
    data, error = load_credential(path)
    if error:
        return False, error
    assert data is not None

    if structure_only:
        return True, "credential structure is valid"

    if data.get("invalid") is True:
        return False, "Google marked the OAuth credential invalid"

    token_response = data.get("token_response")
    if not isinstance(token_response, dict):
        token_response = {}

    has_refresh_lifetime = "refresh_token_expires_in" in token_response
    refresh_lifetime = token_response.get("refresh_token_expires_in")
    token_expiry = parse_utc(data.get("token_expiry"))
    if has_refresh_lifetime:
        try:
            refresh_lifetime_seconds = int(refresh_lifetime)
            access_lifetime_seconds = int(token_response.get("expires_in", 3600))
        except (TypeError, ValueError):
            return False, "OAuth token lifetime metadata is invalid"

        if token_expiry is not None:
            issued_at = token_expiry - timedelta(seconds=access_lifetime_seconds)
            refresh_expiry = issued_at + timedelta(seconds=refresh_lifetime_seconds)
            current_time = now or datetime.now(timezone.utc)
            if current_time >= refresh_expiry:
                return False, "OAuth refresh token has expired"
            if allow_time_limited:
                return True, f"refresh token is time-limited until {refresh_expiry.isoformat()}"
            return False, (
                "OAuth refresh token is time-limited until "
                f"{refresh_expiry.isoformat()}; replace it with non-time-limited authorization"
            )
        return False, (
            "OAuth refresh token is time-limited; replace it with non-time-limited authorization"
        )

    return True, "refresh token is valid"


def main() -> int:
    args = sys.argv[1:]
    structure_only = False
    if args and args[0] == "--structure-only":
        structure_only = True
        args = args[1:]
    if len(args) != 1:
        print(
            "usage: gcalcli-credential-check.py [--structure-only] <oauth-file>",
            file=sys.stderr,
        )
        return 64

    allow_time_limited = os.environ.get("GCALCLI_ALLOW_TIME_LIMITED_OAUTH", "").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    ok, message = validate(
        Path(args[0]),
        structure_only=structure_only,
        allow_time_limited=allow_time_limited,
    )
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
