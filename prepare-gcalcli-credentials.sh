#!/bin/sh
set -eu

GCALCLI_DIR="${GCALCLI_STATE_DIR:-/root/.openclaw/credentials/gcalcli}"
GCALCLI_STATE_FILE="${GCALCLI_STATE_FILE:-$GCALCLI_DIR/oauth}"
GCALCLI_RUNTIME_FILE="${GCALCLI_RUNTIME_FILE:-/root/.gcalcli_oauth}"
GCALCLI_CHECKER="${GCALCLI_CREDENTIAL_CHECKER:-/usr/local/libexec/gcalcli-credential-check}"
GCALCLI_BIN="${GCALCLI_GCALCLI_BIN:-gcalcli}"
LIVE_PROBE_TIMEOUT_SECONDS="${GCALCLI_LIVE_PROBE_TIMEOUT_SECONDS:-15}"
GCALCLI_STATUS_FILE="${GCALCLI_STATUS_FILE:-$GCALCLI_DIR/status}"

IMPORT_FILE=""
RUNTIME_IMPORT_FILE=""

cleanup() {
  if [ -n "$IMPORT_FILE" ]; then rm -f "$IMPORT_FILE"; fi
  if [ -n "$RUNTIME_IMPORT_FILE" ]; then rm -f "$RUNTIME_IMPORT_FILE"; fi
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

umask 077
mkdir -p "$GCALCLI_DIR" "$(dirname "$GCALCLI_RUNTIME_FILE")"
chmod 700 "$GCALCLI_DIR"
if [ -f "$GCALCLI_STATE_FILE" ]; then chmod 600 "$GCALCLI_STATE_FILE"; fi

write_status() {
  status="$1"
  status_file=$(mktemp "$GCALCLI_DIR/status.XXXXXX")
  printf '%s\n' "$status" > "$status_file"
  chmod 600 "$status_file"
  mv "$status_file" "$GCALCLI_STATUS_FILE"
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "${GCALCLI_OAUTH_JSON:-}" ] && [ -n "${GCALCLI_OAUTH_BASE64:-}" ]; then
  echo "gcalcli OAuth import rejected: set only GCALCLI_OAUTH_BASE64" >&2
  write_status "configuration_error"
  exit 64
fi

GCALCLI_IMPORT_FROM_ENV=""
GCALCLI_STATE_STATUS=""
if is_true "${GCALCLI_FORCE_IMPORT:-}"; then
  GCALCLI_IMPORT_FROM_ENV="1"
elif ! GCALCLI_STATE_STATUS=$(python3 "$GCALCLI_CHECKER" "$GCALCLI_STATE_FILE" 2>&1); then
  GCALCLI_IMPORT_FROM_ENV="1"
fi

# The mounted volume remains authoritative while usable. Environment values
# only bootstrap missing/unusable state or an explicitly forced rotation.
if [ -n "$GCALCLI_IMPORT_FROM_ENV" ]; then
  if [ -n "${GCALCLI_OAUTH_JSON:-}" ] || [ -n "${GCALCLI_OAUTH_BASE64:-}" ]; then
    IMPORT_FILE=$(mktemp "$GCALCLI_DIR/oauth.import.XXXXXX")
    if [ -n "${GCALCLI_OAUTH_JSON:-}" ]; then
      echo "Validating gcalcli OAuth credentials from GCALCLI_OAUTH_JSON..."
      printf "%s" "$GCALCLI_OAUTH_JSON" > "$IMPORT_FILE"
    else
      echo "Validating gcalcli OAuth credentials from GCALCLI_OAUTH_BASE64..."
      if ! printf "%s" "$GCALCLI_OAUTH_BASE64" | base64 -d > "$IMPORT_FILE"; then
        echo "gcalcli OAuth import rejected: GCALCLI_OAUTH_BASE64 is not valid base64"
        rm -f "$IMPORT_FILE"
        IMPORT_FILE=""
      fi
    fi

    if [ -n "$IMPORT_FILE" ]; then
      chmod 600 "$IMPORT_FILE"
      if GCALCLI_IMPORT_STATUS=$(python3 "$GCALCLI_CHECKER" "$IMPORT_FILE" 2>&1); then
        mv "$IMPORT_FILE" "$GCALCLI_STATE_FILE"
        IMPORT_FILE=""
        chmod 600 "$GCALCLI_STATE_FILE"
        echo "Imported gcalcli OAuth credentials: $GCALCLI_IMPORT_STATUS"
      else
        echo "gcalcli OAuth import rejected: $GCALCLI_IMPORT_STATUS"
      fi
    fi
  else
    echo "gcalcli OAuth credentials need replacement: ${GCALCLI_STATE_STATUS:-credential file is missing}"
  fi
elif [ -n "${GCALCLI_OAUTH_BASE64:-}${GCALCLI_OAUTH_JSON:-}" ]; then
  echo "Keeping persisted gcalcli OAuth credentials from volume: $GCALCLI_STATE_STATUS"
fi

if GCALCLI_STATE_STATUS=$(python3 "$GCALCLI_CHECKER" "$GCALCLI_STATE_FILE" 2>&1); then
  chmod 600 "$GCALCLI_STATE_FILE"
  RUNTIME_IMPORT_FILE=$(mktemp "${GCALCLI_RUNTIME_FILE}.import.XXXXXX")
  cp "$GCALCLI_STATE_FILE" "$RUNTIME_IMPORT_FILE"
  chmod 600 "$RUNTIME_IMPORT_FILE"
  mv "$RUNTIME_IMPORT_FILE" "$GCALCLI_RUNTIME_FILE"
  RUNTIME_IMPORT_FILE=""
  echo "gcalcli OAuth credentials configured: $GCALCLI_STATE_STATUS"

  case "${GCALCLI_LIVE_PROBE:-1}" in
    0|false|FALSE|no|NO|off|OFF)
      echo "gcalcli live Calendar probe disabled"
      write_status "unchecked"
      ;;
    *)
      if GCALCLI_COMMAND_TIMEOUT_SECONDS="$LIVE_PROBE_TIMEOUT_SECONDS" \
        "$GCALCLI_BIN" --nocolor --nocache agenda now tomorrow >/dev/null 2>&1
      then
        echo "gcalcli live Calendar access ready"
        write_status "ready"
      else
        probe_status=$?
        echo "gcalcli live Calendar probe failed (exit $probe_status)"
        if ! GCALCLI_STATE_STATUS=$(python3 "$GCALCLI_CHECKER" "$GCALCLI_STATE_FILE" 2>&1); then
          rm -f "$GCALCLI_RUNTIME_FILE"
          echo "gcalcli OAuth credentials became unavailable: $GCALCLI_STATE_STATUS"
          write_status "unavailable"
        else
          write_status "probe_failed"
        fi
      fi
      ;;
  esac
else
  rm -f "$GCALCLI_RUNTIME_FILE"
  echo "gcalcli OAuth credentials unavailable: $GCALCLI_STATE_STATUS"
  write_status "unavailable"
fi
