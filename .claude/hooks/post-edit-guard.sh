#!/usr/bin/env bash
# PostToolUse guard for Write|Edit.
#
# Enforces the architectural invariants that a code review would otherwise
# have to catch by eye, and gives fast, file-scoped feedback:
#   1. packages/core must stay DOM-free and deck.gl-free (it runs in Node).
#   2. Nothing under apps/web may carry an Anthropic credential.
#   3. An edited core module re-runs only the Vitest files that import it.
#   4. An edited Python module must at least compile.
#
# Violations of 1 and 2 are reported with decision=block so the model must
# respond to them; test output is passed back as context, not as a block,
# because a mid-refactor red test is expected and should not derail the edit.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT" || exit 0

payload="$(cat)"
file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)"
[ -z "$file" ] && exit 0
rel="${file#"$ROOT"/}"

emit_block() {
  jq -n --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}
emit_context() {
  jq -n --arg c "$1" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
  exit 0
}

# Code lines only: comments may legitimately mention the things code may not use.
code_lines() {
  grep -nvE '^\s*(//|\*|/\*)' "$1" 2>/dev/null
}

case "$rel" in
  packages/core/src/*.ts)
    hits="$(code_lines "$file" | grep -E "from ['\"]@deck\.gl|\bdocument\.|\bwindow\.|\bHTMLElement\b|\blocalStorage\b|\bnavigator\.|requestAnimationFrame" || true)"
    if [ -n "$hits" ]; then
      emit_block "INVARIANT: packages/core must not touch the DOM or import deck.gl (it is unit-tested in plain Node). Offending lines in $rel:
$hits
Move this code to apps/web, or pass the value in from the caller."
    fi
    hits="$(code_lines "$file" | grep -E '\.map\(\s*\(?\s*(c|cell)\s*\)?\s*=>\s*\(?\s*\{' || true)"
    if [ -n "$hits" ]; then
      emit_context "WARNING ($rel): this looks like an array of per-cell objects. Per-cell data must stay in typed arrays; one object per cell caps the viewer at ~100k points.
$hits"
    fi
    ;;
esac

case "$rel" in
  apps/web/*)
    hits="$(grep -nE 'sk-ant-[A-Za-z0-9_-]{8,}|ANTHROPIC_API_KEY|x-api-key' "$file" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
      emit_block "SECURITY: $rel references an Anthropic credential. The API key lives only in the server process (server/chat.py) and must never reach the browser bundle.
$hits"
    fi
    ;;
esac

case "$rel" in
  packages/core/*.ts)
    out="$(set -o pipefail; npx --no-install vitest related "$file" --run --reporter=dot 2>&1 | tail -25)"
    status=$?
    if [ $status -ne 0 ] && ! printf '%s' "$out" | grep -q 'No test files found'; then
      emit_context "Vitest (tests related to $rel) is failing:
$out"
    fi
    ;;
  server/*.py)
    out="$(.venv/bin/python -m py_compile "$file" 2>&1)"
    if [ -n "$out" ]; then
      emit_block "Python syntax error in $rel:
$out"
    fi
    ;;
esac
exit 0
