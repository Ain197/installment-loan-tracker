#!/usr/bin/env bash
# Copies the files of ONE step of team/plan.txt from the full project folder into this repository
# and commits them with your own Git identity. Run it from the root of your clone, on your branch.
#
#   bash team/commit-step.sh A3 /c/Users/<you>/Downloads/installment-loan-tracker
#   bash team/commit-step.sh --list A        (shows your steps and which ones are already committed)
#
# Read the files of a step before you commit them: you will have to explain them in the discussion.
set -euo pipefail
PLAN="$(dirname "$0")/plan.txt"

if [ "${1:-}" = "--list" ]; then
  who="${2:?usage: --list A|B|C}"
  grep -E "^${who}[0-9]+\|" "$PLAN" | while IFS='|' read -r step msg files; do
    if git log --oneline --fixed-strings --grep "[$step]" 2>/dev/null | grep -q .; then mark="done"; else mark="todo"; fi
    printf '  %-3s %-5s %s\n' "$step" "$mark" "$msg"
  done
  exit 0
fi

step="${1:?usage: bash team/commit-step.sh STEP /path/to/full/project}"
src="${2:?give the path of the full project folder (unzipped installment-loan-tracker)}"
line="$(grep -E "^${step}\|" "$PLAN" || true)"
[ -n "$line" ] || { echo "No step $step in team/plan.txt"; exit 1; }
IFS='|' read -r _ msg files <<< "$line"

if git log --oneline --fixed-strings --grep "[$step]" 2>/dev/null | grep -q .; then echo "Step $step is already committed."; exit 0; fi
name="$(git config user.name || true)"; email="$(git config user.email || true)"
[ -n "$name" ] && [ -n "$email" ] || { echo "Set your identity first: git config user.name \"Your Name\"; git config user.email you@example.com"; exit 1; }

for f in $files; do
  [ -f "$src/$f" ] || { echo "Missing in the full project: $f"; exit 1; }
  mkdir -p "$(dirname "$f")"
  cp "$src/$f" "$f"
done
git add $files
echo "Files in $step:"; git diff --cached --stat | sed 's/^/  /'
git commit -q -m "$msg [$step]"
echo "Committed as $name <$email>: $msg [$step]"
echo "Push when ready: git push -u origin $(git rev-parse --abbrev-ref HEAD)"
