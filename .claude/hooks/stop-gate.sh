#!/usr/bin/env bash
# Stop hook: refuses to let a turn end on a red tree.
#
# Runs only when a source file changed since the last green run, so a turn
# that touched nothing pays nothing. On failure it blocks once with the
# failing output; `stop_hook_active` stops it from blocking twice in a row,
# so it can never trap the session in a loop.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" || exit 0

payload="$(cat)"
active="$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null)"
[ "$active" = "true" ] && exit 0

STAMP=".claude/.last-green"
changed_ts="$(find packages apps e2e -name '*.ts' -newer "$STAMP" 2>/dev/null | head -1)"
changed_py="$(find server -name '*.py' -newer "$STAMP" 2>/dev/null | head -1)"
if [ -f "$STAMP" ] && [ -z "$changed_ts" ] && [ -z "$changed_py" ]; then
  exit 0
fi

fail=""
if [ ! -f "$STAMP" ] || [ -n "$changed_ts" ]; then
  out="$(set -o pipefail; npx --no-install tsc --noEmit 2>&1 | tail -30)"
  [ $? -ne 0 ] && fail="$fail
--- tsc --noEmit ---
$out"
  out="$(set -o pipefail; npx --no-install vitest run --reporter=dot 2>&1 | tail -30)"
  [ $? -ne 0 ] && fail="$fail
--- vitest run ---
$out"
fi
if [ ! -f "$STAMP" ] || [ -n "$changed_py" ]; then
  out="$(set -o pipefail; .venv/bin/python -m pytest -q -x 2>&1 | tail -30)"
  [ $? -ne 0 ] && fail="$fail
--- pytest ---
$out"
fi

if [ -n "$fail" ]; then
  jq -n --arg r "Quality gate failed. Fix these before finishing:$fail" '{decision: "block", reason: $r}'
  exit 0
fi
touch "$STAMP"
exit 0
