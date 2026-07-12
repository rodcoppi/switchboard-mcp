#!/usr/bin/env bash
#
# spikes/02-sendkeys-claude.sh — Spike 0.3 of the PRD (section 16)
#
# Validates the standard send-keys technique (PRD 10.2/10.3, pitfalls P1/P3/P5/P9)
# against a REAL Claude Code running inside tmux:
#
#   1. Creates session sb-spike1 running `claude` in /tmp.
#   2. Waits for the TUI to become ready (poll, no blind sleep), handling the
#      trust dialog that appears when opening a new directory.
#   3. Sends a prompt with the standard technique: `send-keys -l --` + ~500ms
#      delay + Enter in a SEPARATE command (pitfall P1).
#   4. Polls the pane until it detects the model's RESPONSE (a criterion robust
#      against the false positive of the typed text itself — see below).
#   5. Prints the observed timings (readiness and response), which feed
#      NOTES.md and recalibrate nudgeEnterDelayMs.
#
# ATTENTION: this script opens a REAL Claude Code instance and consumes
# tokens. It should only be run by the Phase 0 orchestrator.
#
# Usage: ./02-sendkeys-claude.sh [--keep]
#   --keep  do not kill the session at the end — needed for step 4 of PRD
#           0.3 (manual queue test: with Claude busy on a long turn,
#           fire another send-keys and observe the queueing — P3).
#
# Dependencies: bash, tmux, coreutils. Requires an authenticated `claude` on PATH.
# Exit codes: 0 = PASS, 1 = FAIL, 2 = usage/prerequisite error.
#
# Note: we use `set -u` but NOT `set -e`, because the poll loops rely on
# commands that fail legitimately (captures during redraw, etc.);
# each relevant error is handled explicitly.

set -u

SESSION="sb-spike1"
READINESS_TIMEOUT_S=60
READINESS_POLL_S=2
ANSWER_TIMEOUT_S=90
ANSWER_POLL_S=3
PROMPT="Reply only with the word PONG."

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "usage: $0 [--keep]" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not found in PATH (Phase 0.1 prerequisite)." >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude not found in PATH (Phase 0.1 prerequisite)." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '%s\n' "$*"; }

# Captures the pane's recent history (last 60 scrollback lines,
# as specified in PRD 0.3 step 3).
capture_history() {
  tmux capture-pane -t "=$SESSION:" -p -S -60 2>/dev/null
}

# Captures only the pane's visible area (to detect dialogs/readiness,
# where what matters is the CURRENT screen state, not the scrollback).
capture_visible() {
  tmux capture-pane -t "=$SESSION:" -p 2>/dev/null
}

session_alive() {
  tmux has-session -t "=$SESSION" 2>/dev/null
}

cleanup() {
  if (( KEEP )); then
    log "[keep] session $SESSION kept alive for the manual queue test (PRD 0.3 step 4)."
    log "[keep] observe: tmux attach -t $SESSION   |   end: tmux kill-session -t $SESSION"
  else
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
  fi
}

fail() {
  log "FAIL: $*"
  log "----- pane capture (last 60 lines) for debug -----"
  capture_history || log "(capture unavailable — the session already died)"
  log "-----------------------------------------------------------"
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Clean session: kill any pre-existing one and create a new one running `claude` in /tmp
# ---------------------------------------------------------------------------
tmux kill-session -t "=$SESSION" 2>/dev/null || true

trap cleanup EXIT

# -x/-y fix the pane size (tmux >= 3.2): without this the session would inherit
# the user's tmux.conf default-size, and a small width could break the
# prompt echo across two lines — invalidating the no-wrap guarantee that the
# response detection criterion (step 5) relies on.
if ! tmux new-session -d -x 200 -y 50 -s "$SESSION" -c /tmp claude; then
  fail "could not create tmux session $SESSION"
fi
log "session $SESSION created (claude in /tmp, pane 200x50); waiting for TUI readiness..."

# ---------------------------------------------------------------------------
# 2. READINESS: poll every ${READINESS_POLL_S}s for up to ${READINESS_TIMEOUT_S}s
#
# Chosen readiness marker: the string "? for shortcuts".
# Why: interactive Claude Code renders this hint on the status line
# just below the input box, and it only appears once the TUI is actually
# ready to receive input — it does not appear in the trust dialog or on
# login screens. It is a stable marker across 1.x/2.x versions.
# Fallback: the string "│ >" — the input box line itself (vertical border
# U+2502 + ASCII ">" prompt). Covers future versions that change the hint
# line text. The trust dialog uses "❯" (U+276F) as the selection cursor,
# not ASCII ">", so the fallback does not collide with it.
#
# Trust dialog: opening `claude` in a new directory like /tmp may show
# "Do you trust the files in this folder?". Enter accepts the default
# ("Yes, proceed"). We detect it and send Enter as many times as the dialog
# appears in the capture (resending is harmless: Enter with an empty input box
# is ignored by the TUI), and keep polling.
#
# Time measurement: $SECONDS (bash builtin) — never `date +%s` inside
# unsafe interpolation.
# ---------------------------------------------------------------------------
readiness_start=$SECONDS
ready=0
trust_enters=0

while (( SECONDS - readiness_start < READINESS_TIMEOUT_S )); do
  if ! session_alive; then
    fail "session died during boot (did claude exit? check authentication)"
  fi

  pane="$(capture_visible || true)"

  # The trust dialog takes priority over the readiness check.
  # Known wordings: "Do you trust the files in this folder?" (old) and
  # "Quick safety check ... Yes, I trust this folder" (claude 2.1.205).
  if [[ "${pane,,}" == *"trust the files"* || "${pane,,}" == *"trust this folder"* || "${pane,,}" == *"quick safety check"* ]]; then
    tmux send-keys -t "=$SESSION:" Enter
    trust_enters=$(( trust_enters + 1 ))
    log "trust dialog detected; Enter sent (accepting the default) [${trust_enters}x]"
    sleep "$READINESS_POLL_S"
    continue
  fi

  if [[ "$pane" == *"? for shortcuts"* || "$pane" == *"│ >"* ]]; then
    ready=1
    break
  fi

  sleep "$READINESS_POLL_S"
done

if (( ! ready )); then
  fail "timeout of ${READINESS_TIMEOUT_S}s waiting for the TUI to become ready (marker '? for shortcuts' / '│ >' did not appear)"
fi

readiness_elapsed=$(( SECONDS - readiness_start ))
log "TUI ready in ${readiness_elapsed}s (trust dialogs handled: ${trust_enters})"

# Small post-render grace period: the TUI just drew the input box; 1s avoids
# sending keystrokes in the middle of an initial redraw.
sleep 1

# ---------------------------------------------------------------------------
# 3. Pane-command guard (PRD 10.3, pitfall P2 — security invariant)
#
# If claude had exited leaving a shell in the pane, the send-keys below
# would execute the text as a command. In this spike the session runs `claude`
# as a direct command (no underlying shell), but the guard stays as a safety
# belt and mirrors the dispatcher's mandatory behavior.
# ---------------------------------------------------------------------------
pane_cmd="$(tmux list-panes -t "=$SESSION:" -F '#{pane_current_command}' 2>/dev/null || true)"
# Fail-closed guard (PRD 10.3): if we cannot READ the pane's command,
# we cannot assert it is safe to type into it — abort, never proceed.
if [[ -z "$pane_cmd" ]]; then
  fail "could not verify pane_current_command — aborting send-keys (fail-closed guard, PRD 10.3)"
fi
case "$pane_cmd" in
  bash|zsh|sh|dash|fish)
    fail "pane runs a shell ('$pane_cmd') — aborting send-keys (P2: text would become a command)"
    ;;
esac
log "pane-command guard ok (pane_current_command='$pane_cmd')"

# ---------------------------------------------------------------------------
# 4. Prompt send — standard technique (PRD 10.2, pitfalls P1/P5/P9):
#    - `-l` (literal): tmux does not interpret the text as key names;
#    - `--`: guards against text starting with "-";
#    - text is a single line (no \r\n — P5);
#    - Enter in a SEPARATE command after ~500ms: in the same command the text is
#      typed but NOT submitted in TUIs (P1).
# ---------------------------------------------------------------------------
log "sending prompt: \"$PROMPT\""
if ! tmux send-keys -t "=$SESSION:" -l -- "$PROMPT"; then
  fail "send-keys of the text failed"
fi
sleep 0.5
if ! tmux send-keys -t "=$SESSION:" Enter; then
  fail "send-keys of the Enter failed"
fi
log "prompt submitted (text→Enter delay: 500ms); waiting for the model's response..."

# ---------------------------------------------------------------------------
# 5. Poll the RESPONSE: every ${ANSWER_POLL_S}s for up to ${ANSWER_TIMEOUT_S}s,
#    with capture-pane -S -60.
#
# False positive to avoid: the typed text ALREADY CONTAINS "PONG" — the prompt
# echo appears in the transcript as "> Reply only with the word PONG.",
# and the 60-line scrollback may contain STALE FRAMES of the Ink TUI (pre-submit
# input box with the typed text, duplicated echoes after redraws), each one
# carrying the whole prompt. That is why counting occurrences of "PONG" in the
# capture does NOT work as a criterion: stale frames duplicate the prompt and would
# give a false PASS — even masking exactly the pitfall P1 (an Enter that never
# submitted) that this spike exists to detect.
# Success criterion (single), evaluated line by line:
#   a line containing "PONG" (case-insensitive, tolerating "Pong."/
#   "pong" from the model) that does NOT contain "Reply" and that is NOT an input
#   box line (does not start with "│ >" nor ">"). The prompt echo has "Reply" and
#   "PONG" on the SAME line: with the pane fixed at 200 columns on session
#   creation and the prompt ~30 characters long, there is no wrap to split them.
# ---------------------------------------------------------------------------
answer_start=$SECONDS
answered=0
criterion=""

while (( SECONDS - answer_start < ANSWER_TIMEOUT_S )); do
  if ! session_alive; then
    fail "session died while waiting for the response"
  fi

  cap="$(capture_history || true)"

  # Line with PONG (case-insensitive), without "Reply", outside the input box
  # (pure bash, no grep).
  while IFS= read -r line; do
    # Input box line (live or stale pre-submit frame) never counts as a
    # response — that is where typed-but-not-submitted text would appear.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    if [[ "$trimmed" == "│ >"* || "$trimmed" == ">"* ]]; then
      continue
    fi
    up="${line^^}"
    if [[ "$up" == *PONG* && "$up" != *REPLY* ]]; then
      answered=1
      criterion="line with PONG (case-insensitive) without 'Reply', outside the input box"
      break
    fi
  done <<< "$cap"
  (( answered )) && break

  sleep "$ANSWER_POLL_S"
done

answer_elapsed=$(( SECONDS - answer_start ))

if (( ! answered )); then
  fail "timeout of ${ANSWER_TIMEOUT_S}s without detecting the model's PONG response"
fi

# ---------------------------------------------------------------------------
# 6. Result — the timings below feed spikes/NOTES.md and recalibrate
#    nudgeEnterDelayMs (PRD 0.3 Done When).
# ---------------------------------------------------------------------------
log ""
log "===== observed metrics (for NOTES.md) ====="
log "TUI readiness:               ${readiness_elapsed}s"
log "model response (post-Enter): ${answer_elapsed}s"
log "trust dialogs:               ${trust_enters}"
log "detection criterion:         ${criterion}"
log "text->Enter delay used:      500ms (nudgeEnterDelayMs)"
log "==============================================="
log ""
log "PASS: send-keys delivered and submitted the prompt; PONG response detected."
exit 0
