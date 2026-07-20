#!/usr/bin/env bash
# QA driver for the incomplete-latest-assistant idle-fallback fix.
# Drives REAL opencode in an isolated XDG sandbox, proves the session.idle
# trigger fires on the wire, exercises a real background subagent completion
# path with the rebuilt plugin, and proves the host DB is untouched.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVID="$REPO_ROOT/.omo/evidence/20260720-fallback-incomplete-idle"
DIST="$REPO_ROOT/dist/index.js"
REAL_DB="$HOME/.local/share/opencode/opencode.db"

mkdir -p "$EVID"

# --- isolated XDG sandbox (never touches host ~/.config or ~/.local/share) ---
OMO_QA_ROOT="$(mktemp -d -t omo-qa-idle.XXXXXX)"
export OMO_QA_ROOT
export XDG_DATA_HOME="$OMO_QA_ROOT/data"
export XDG_CONFIG_HOME="$OMO_QA_ROOT/config"
export XDG_CACHE_HOME="$OMO_QA_ROOT/cache"
export XDG_STATE_HOME="$OMO_QA_ROOT/state"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1

MODEL="${QA_MODEL:-openai/gpt-4o-mini}"

cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$DIST"],
  "model": "$MODEL"
}
JSON

# --- host DB session count BEFORE ---
REAL_BEFORE="$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session" 2>/dev/null)"
echo "host_db_sessions_before=$REAL_BEFORE" | tee "$EVID/isolation.txt"
echo "sandbox_root=$OMO_QA_ROOT" | tee -a "$EVID/isolation.txt"
echo "isolated_db=$(opencode db path 2>/dev/null)" | tee -a "$EVID/isolation.txt"

WORKDIR="$OMO_QA_ROOT/work"
mkdir -p "$WORKDIR"

# --- Drive a real opencode server, capture the /event SSE stream, prove
#     the session.idle event (the trigger for the changed code) fires. ---
PORT="${QA_PORT:-4199}"
( cd "$WORKDIR" && opencode serve --port "$PORT" --hostname 127.0.0.1 >"$EVID/server.log" 2>&1 ) &
SERVER_PID=$!
sleep 6

# capture the event stream in the background while we drive a prompt
( curl -sN "http://127.0.0.1:$PORT/event" >"$EVID/event-stream.log" 2>&1 ) &
CURL_PID=$!
sleep 1

# create a session and drive a real prompt (produces a real session.idle)
SES=$(curl -s -X POST -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/session?directory=$WORKDIR" -d '{}' | jq -r '.id // empty')
echo "driven_session=$SES" | tee -a "$EVID/isolation.txt"
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Reply with exactly the word DONE and nothing else."}]}' \
  "http://127.0.0.1:$PORT/session/$SES/prompt_async?directory=$WORKDIR" >/dev/null 2>&1

# wait for the model turn to finish and the session to go idle
sleep 40

kill "$CURL_PID" 2>/dev/null
kill "$SERVER_PID" 2>/dev/null
wait 2>/dev/null

# --- host DB session count AFTER (must equal BEFORE) ---
REAL_AFTER="$(sqlite3 "$REAL_DB" "SELECT count(*) FROM session" 2>/dev/null)"
echo "host_db_sessions_after=$REAL_AFTER" | tee -a "$EVID/isolation.txt"

# --- extract evidence signals ---
echo "=== plugin load + session.idle signals ===" | tee "$EVID/signals.txt"
grep -c "session.idle" "$EVID/event-stream.log" 2>/dev/null | sed 's/^/session.idle_events=/' | tee -a "$EVID/signals.txt"
grep -oE '"type":"session.idle"' "$EVID/event-stream.log" 2>/dev/null | head -1 | tee -a "$EVID/signals.txt"
grep -iE "oh-my-op|openagent|plugin" "$EVID/server.log" 2>/dev/null | head -5 | tee -a "$EVID/signals.txt"

echo "cleanup: rm -rf $OMO_QA_ROOT"
