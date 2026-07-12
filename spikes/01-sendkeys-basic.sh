#!/usr/bin/env bash
#
# spikes/01-sendkeys-basic.sh — Phase 0, item 0.2 of the PRD (basic send-keys spike)
#
# Validates Switchboard's standard nudge technique (PRD 10.2/10.3):
#   1. text sent with `tmux send-keys -l --` (-l = literal, otherwise tmux
#      interprets key names; -- guards against text starting with "-")
#   2. ~500ms delay
#   3. Enter in a SEPARATE tmux command
#
# SCOPE (important for NOTES.md): this spike validates ONLY input delivery
# via send-keys in a pane running `cat`. Since the `cat` pty is in canonical
# mode, the line would be submitted on the newline even if text+Enter were sent
# in the SAME send-keys — that is, the failure mode of pitfall P1 (PRD section 17)
# is NEITHER reproducible NOR dismissible here: it only manifests in raw-mode
# TUIs and is validated in spike 02, with a real Claude Code. The send
# sequence (text -l, ~500ms, separate Enter) is used here only to exercise
# the SAME technique the dispatcher will use. A PASS here says nothing about P1.
#
# PASS criterion: the pane runs `cat`. A SUBMITTED line appears TWICE
# in capture-pane: once from the tty echo (what was typed) and once from cat's
# own output (which only echoes the line AFTER Enter submits it). Therefore:
#   - count >= 2  → Enter delivered and line submitted → PASS
#   - count == 1  → Enter was NOT delivered/processed (delivery failure,
#                      e.g. wrong target/pane — NOT P1; see SCOPE) → FAIL
#   - count == 0  → send-keys delivered nothing → FAIL
#
# tmux targets always with the `=` prefix (EXACT session name match): without it,
# tmux resolves targets by PREFIX when there is no exact name, and kill-session
# could kill a user's working session named, e.g., "sb-spike01".
# ATTENTION (empirical finding, tmux 3.4): in target-PANE commands (send-keys,
# capture-pane), "=NAME" alone fails with "can't find pane"; the correct form
# for an exact match is "=NAME:" (with a colon, qualifying it as session:window).
# In target-SESSION commands (has-session, kill-session), "=NAME" works.
#
# Only bash + tmux + coreutils. No `set -e`: has-session and grep have an
# expected exit != 0; critical failures are handled explicitly with fail().

set -u

SESSION="sb-spike0"
TEXT="hello switchboard"

cleanup() {
  # ALWAYS kill the spike session, including on failure or interruption.
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "FAIL: $1"
  if [ -n "${2-}" ]; then
    echo "---- capture-pane (debug) ----"
    printf '%s\n' "$2"
    echo "------------------------------"
  fi
  exit 1
}

command -v tmux >/dev/null 2>&1 \
  || fail "tmux not found in PATH (prerequisite: tmux >= 3.2)" ""

# Minimum version required by the PRD (item 0.1 / section 5): tmux >= 3.2. A PASS
# on an older tmux would mask an out-of-spec environment.
TMUX_VERSION_RAW="$(tmux -V 2>/dev/null || true)"
TMUX_VERSION_NUM="$(printf '%s\n' "$TMUX_VERSION_RAW" | grep -oE '[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ -z "$TMUX_VERSION_NUM" ]; then
  echo "WARNING: could not parse the tmux version ('$TMUX_VERSION_RAW');" \
       "proceeding, but manually confirm it is >= 3.2 (PRD section 5)."
else
  TMUX_MAJOR="${TMUX_VERSION_NUM%%.*}"
  TMUX_MINOR="${TMUX_VERSION_NUM#*.}"
  if [ "$TMUX_MAJOR" -lt 3 ] || { [ "$TMUX_MAJOR" -eq 3 ] && [ "$TMUX_MINOR" -lt 2 ]; }; then
    fail "tmux version out of spec: '$TMUX_VERSION_RAW' (PRD requires >= 3.2)" ""
  fi
fi

# Kill a pre-existing session with the same name (exit != 0 from has-session is
# expected when it does not exist — that is why it stays outside any set -e).
# `=` forces an exact match: never kill someone else's session by prefix.
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
fi

# Detached session running `cat`: each submitted line comes back echoed by cat.
tmux new-session -d -s "$SESSION" cat \
  || fail "could not create tmux session '$SESSION'" ""

# Small grace period for the pane and cat to be ready before send-keys.
sleep 0.3

# 1) Literal text, with mandatory -l and -- (PRD 10.3).
tmux send-keys -t "=$SESSION:" -l -- "$TEXT" \
  || fail "send-keys of the text failed" ""

# 2) ~500ms delay and Enter in a SEPARATE command (same technique as the dispatcher).
sleep 0.5
tmux send-keys -t "=$SESSION:" Enter \
  || fail "send-keys of the Enter failed" ""

# 3) Poll the pane: capture every 0.2s for up to ~5s, exiting as soon as the
#    submitted line appears >= 2x. A fixed sleep + single capture yields a false
#    negative under load on WSL2 (cat's echo not yet visible at capture time).
#    grep -c exits with exit 1 when the count is 0 — a valid result, hence `|| true`.
PANE_OUTPUT=""
COUNT=0
MAX_POLLS=25   # 25 x 0.2s = ~5s
i=0
while [ "$i" -lt "$MAX_POLLS" ]; do
  sleep 0.2
  if ! PANE_OUTPUT="$(tmux capture-pane -t "=$SESSION:" -p)"; then
    fail "capture-pane failed" ""
  fi
  COUNT="$(printf '%s\n' "$PANE_OUTPUT" | grep -c -F -- "$TEXT" || true)"
  if [ "$COUNT" -ge 2 ]; then
    break
  fi
  i=$((i + 1))
done

if [ "$COUNT" -ge 2 ]; then
  echo "PASS (${TMUX_VERSION_RAW:-unknown tmux version}; submitted line appeared ${COUNT}x in the pane)"
  exit 0
elif [ "$COUNT" -eq 1 ]; then
  fail "text appeared 1x after ~5s: Enter was not delivered/processed (delivery failure — NOT pitfall P1; P1 is only testable in a raw-mode TUI, in spike 02 with a real Claude Code)" "$PANE_OUTPUT"
else
  fail "text did not appear in the pane: send-keys delivered nothing" "$PANE_OUTPUT"
fi
