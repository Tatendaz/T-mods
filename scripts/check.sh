#!/usr/bin/env bash
# Checks every mod in this repo: manifest and module validate, tests pass,
# the README lists it, and ~/.claude/settings.json loads it.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
settings="$HOME/.claude/settings.json"
failed=0

for manifest in "$root"/*/.claude-plugin/plugin.json; do
  dir="$(dirname "$(dirname "$manifest")")"
  name="$(basename "$dir")"
  echo "== $name"

  out="$(claude plugin validate "$dir" 2>&1)"
  if ! grep -q "Validation passed" <<<"$out"; then
    echo "$out"
    echo "FAIL $name: claude plugin validate"
    failed=1
  fi

  if compgen -G "$dir/tests/*.test.ts*" >/dev/null; then
    if ! claude plugin test "$dir" 2>&1 | tail -4 | grep -q " 0 fail"; then
      claude plugin test "$dir" 2>&1 | tail -20
      echo "FAIL $name: claude plugin test"
      failed=1
    fi
  else
    echo "FAIL $name: no tests/*.test.ts or tests/*.test.tsx"
    failed=1
  fi

  [ -f "$dir/README.md" ] || { echo "FAIL $name: no $name/README.md"; failed=1; }
  grep -q "](${name}/)" "$root/README.md" || { echo "FAIL $name: not in the README mods table"; failed=1; }

  if ! python3 - "$settings" "$name" <<'PY'
import json, os, sys
dirs = json.load(open(sys.argv[1])).get("env", {}).get("CLAUDE_CODE_PLUGIN_DIRS", "")
want = os.path.expanduser(f"~/.claude/mods/{sys.argv[2]}")
sys.exit(0 if want in [os.path.expanduser(p) for p in dirs.split(":") if p] else 1)
PY
  then
    echo "FAIL $name: not in CLAUDE_CODE_PLUGIN_DIRS in $settings"
    failed=1
  fi
done

[ "$failed" -eq 0 ] && echo "all mods OK"
exit "$failed"
