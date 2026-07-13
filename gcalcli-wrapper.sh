#!/bin/sh
set -eu

STATE_DIR="${GCALCLI_STATE_DIR:-/root/.openclaw/credentials/gcalcli}"
STATE_FILE="${GCALCLI_STATE_FILE:-$STATE_DIR/oauth}"
RUNTIME_FILE="${GCALCLI_RUNTIME_FILE:-/root/.gcalcli_oauth}"
REAL_GCALCLI="${GCALCLI_REAL_BIN:-/usr/bin/gcalcli}"
CHECKER="${GCALCLI_CREDENTIAL_CHECKER:-/usr/local/libexec/gcalcli-credential-check}"
COMMAND_TIMEOUT_SECONDS="${GCALCLI_COMMAND_TIMEOUT_SECONDS:-45}"
STATE_IMPORT_FILE=""
RUNTIME_SEED_FILE=""

umask 077
mkdir -p "$STATE_DIR" "$(dirname "$RUNTIME_FILE")"
chmod 700 "$STATE_DIR"

case "$COMMAND_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    echo "gcalcli: GCALCLI_COMMAND_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 64
    ;;
  0)
    echo "gcalcli: GCALCLI_COMMAND_TIMEOUT_SECONDS must be greater than zero" >&2
    exit 64
    ;;
esac

# Prevent concurrent calendar commands from racing the shared oauth2client file.
exec 9>"$STATE_DIR/command.lock"
if ! flock -w 5 9; then
  echo "gcalcli: another calendar command is already running" >&2
  exit 75
fi

if ! credential_status=$(python3 "$CHECKER" "$STATE_FILE" 2>&1); then
  echo "gcalcli: calendar authentication unavailable: $credential_status" >&2
  echo "gcalcli: update GCALCLI_OAUTH_BASE64 with a newly authorized credential" >&2
  exit 78
fi
chmod 600 "$STATE_FILE"

# oauth2client does not reliably handle a symlinked auth file. Seed a real
# runtime file atomically from validated volume state before every command so
# a malformed/newer runtime file cannot poison all later Calendar calls.
RUNTIME_SEED_FILE=$(mktemp "${RUNTIME_FILE}.seed.XXXXXX")
cp "$STATE_FILE" "$RUNTIME_SEED_FILE"
chmod 600 "$RUNTIME_SEED_FILE"
mv "$RUNTIME_SEED_FILE" "$RUNTIME_FILE"
RUNTIME_SEED_FILE=""

sync_runtime_to_state() {
  if [ -f "$RUNTIME_FILE" ]; then
    if credential_structure_status=$(python3 "$CHECKER" --structure-only "$RUNTIME_FILE" 2>&1); then
      STATE_IMPORT_FILE=$(mktemp "$STATE_DIR/oauth.runtime-import.XXXXXX")
      if cp "$RUNTIME_FILE" "$STATE_IMPORT_FILE"; then
        chmod 600 "$STATE_IMPORT_FILE"
        mv "$STATE_IMPORT_FILE" "$STATE_FILE"
        STATE_IMPORT_FILE=""
      else
        rm -f "$STATE_IMPORT_FILE"
        STATE_IMPORT_FILE=""
        echo "gcalcli: could not stage refreshed OAuth credentials" >&2
      fi
    else
      echo "gcalcli: refreshed OAuth state was not persisted: $credential_structure_status" >&2
    fi
  fi
}

cleanup_temp_files() {
  if [ -n "$STATE_IMPORT_FILE" ]; then rm -f "$STATE_IMPORT_FILE"; fi
  if [ -n "$RUNTIME_SEED_FILE" ]; then rm -f "$RUNTIME_SEED_FILE"; fi
}

trap 'sync_runtime_to_state; cleanup_temp_files' EXIT
trap 'exit 143' HUP INT TERM

status=0
timeout --signal=TERM --kill-after=5 "$COMMAND_TIMEOUT_SECONDS" "$REAL_GCALCLI" "$@" || status=$?
sync_runtime_to_state
cleanup_temp_files
trap - EXIT HUP INT TERM

if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "gcalcli: command timed out after ${COMMAND_TIMEOUT_SECONDS}s" >&2
fi

exit "$status"
