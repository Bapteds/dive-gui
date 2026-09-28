#!/usr/bin/env bash
# Stop hook: keep the brain in sync with the code.
# 1. Blocks the stop ONCE when a tracked code/config file was modified (uncommitted)
#    more recently than the newest brain/changelog/*.md file.
# 2. Otherwise, if Python is available: blocks ONCE when a repository file has no
#    description in brain/codemap (build-index.py --check), else silently
#    regenerates brain/INDEX.md.
# Never loops: a stop that is already the result of this hook (stop_hook_active)
# always passes. Portable: Git Bash on Windows, WSL, Linux.

input="$(cat)"
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Newest changelog write (0 if none).
latest_log=0
for f in brain/changelog/*.md; do
  [ -f "$f" ] || continue
  t=$(date -r "$f" +%s 2>/dev/null) || continue
  [ "$t" -gt "$latest_log" ] && latest_log=$t
done

# Uncommitted code/config paths (renames: keep the new path; skip deletions).
newer=""
while IFS= read -r line; do
  status="${line:0:2}"
  path="${line:3}"
  path="${path##* -> }"
  path="${path%\"}"; path="${path#\"}"
  case "$status" in *D*) continue ;; esac
  case "$path" in
    apps/*|packages/*|.github/*|package.json|tsconfig*.json|eslint.config.js|.prettierrc.json|.mcp.json) ;;
    *) continue ;;
  esac
  [ -f "$path" ] || continue
  t=$(date -r "$path" +%s 2>/dev/null) || continue
  if [ "$t" -gt "$latest_log" ]; then newer="$path"; break; fi
done < <(git status --porcelain --untracked-files=all 2>/dev/null)

if [ -z "$newer" ]; then
  py=""
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys; sys.exit(sys.version_info < (3, 8))" >/dev/null 2>&1; then
      py="$cand"; break
    fi
  done
  [ -z "$py" ] && exit 0
  undocumented=$("$py" brain/codemap/build-index.py --check 2>/dev/null | grep '^undocumented:' | sed 's/^undocumented: //' | head -5 | tr '
' ' ')
  if [ -n "$undocumented" ]; then
    cat <<JSON
{"decision":"block","reason":"Brain: files without a description in brain/codemap: $undocumented. Add their section (template brain/codemap/_FORMAT.md) to the codemap sheet of their area, then run: python brain/codemap/build-index.py"}
JSON
    exit 0
  fi
  "$py" brain/codemap/build-index.py >/dev/null 2>&1
  exit 0
fi

cat <<JSON
{"decision":"block","reason":"Brain: code was modified ($newer) after the latest brain/changelog/ entry. Before finishing, add the entry at the top of brain/changelog/$(date +%Y-%m).md (format: brain/changelog/README.md, in English) and update codemap / features / STATUS / playbooks if needed (brain/README.md section 3). If these changes are not yours or are already logged, just say so and finish."}
JSON
exit 0
