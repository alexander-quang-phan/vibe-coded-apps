#!/bin/bash
# Stop hook for Trim: if feature code changed this session but BUILD_PLAN.md /
# FEATURES.md didn't, nudge Claude once to update the docs before stopping.
# (Definition of done lives in CLAUDE.md — this catches the drift that caused
# BUILD_PLAN.md to fall out of date in past sessions.)

input=$(cat)

# Loop guard: if we already blocked once this stop, allow the stop.
case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

repo="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$repo" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Files touched: uncommitted changes, plus the HEAD commit if it's recent
# (< 4h old — i.e. likely made this session, not leftover from an old one).
changed="$(git status --porcelain 2>/dev/null | awk '{print $NF}')"
head_age=$(( $(date +%s) - $(git log -1 --format=%ct 2>/dev/null || echo 0) ))
if [ "$head_age" -lt 14400 ]; then
  changed="$changed
$(git show --name-only --format= HEAD 2>/dev/null)"
fi

code=$(printf '%s\n' "$changed" | grep -E '^(client/src/|server/)' | grep -v node_modules | head -1)
docs=$(printf '%s\n' "$changed" | grep -E '(BUILD_PLAN|FEATURES)\.md' | head -1)

if [ -n "$code" ] && [ -z "$docs" ]; then
  cat <<'EOF'
{"decision":"block","reason":"Trim housekeeping check: feature code changed (client/src or server) but BUILD_PLAN.md / FEATURES.md were not updated. If a feature was added or changed this session, update BUILD_PLAN.md progress and FEATURES.md now, per the definition of done in CLAUDE.md. If this was not feature work (investigation or pure refactor) or the docs are genuinely current, you may stop — just say so briefly."}
EOF
fi
exit 0
