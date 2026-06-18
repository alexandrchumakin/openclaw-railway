#!/bin/sh
set -eu

STATE_DIR="${GCALCLI_STATE_DIR:-/root/.openclaw/credentials/gcalcli}"
STATE_FILE="${GCALCLI_STATE_FILE:-$STATE_DIR/oauth}"
RUNTIME_FILE="${GCALCLI_RUNTIME_FILE:-/root/.gcalcli_oauth}"
REAL_GCALCLI="${GCALCLI_REAL_BIN:-/usr/bin/gcalcli}"

mkdir -p "$STATE_DIR"

# oauth2client does not reliably handle a symlinked auth file, so keep the
# runtime auth file real and sync it with the Railway-mounted volume.
if [ -f "$STATE_FILE" ]; then
  if [ ! -f "$RUNTIME_FILE" ] || [ "$STATE_FILE" -nt "$RUNTIME_FILE" ]; then
    cp "$STATE_FILE" "$RUNTIME_FILE"
    chmod 600 "$RUNTIME_FILE"
  fi
fi

sync_runtime_to_state() {
  if [ -f "$RUNTIME_FILE" ]; then
    cp "$RUNTIME_FILE" "$STATE_FILE"
    chmod 600 "$STATE_FILE"
  fi
}

trap sync_runtime_to_state EXIT

status=0
"$REAL_GCALCLI" "$@" || status=$?
sync_runtime_to_state
trap - EXIT
exit "$status"
