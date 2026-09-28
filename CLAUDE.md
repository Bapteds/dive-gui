# CLAUDE.md · DIVE Turbinen

@AGENTS.md

## Claude Code specifics

### Quick start for a task
1. `brain/STATUS.md` (state, pitfalls, pending questions) + top of the current month's changelog (`brain/changelog/YYYY-MM.md`).
2. Find files: `brain/INDEX.md` (every file, one line each; search it, do not read it whole) or `brain/features/README.md` (by feature).
3. Understand a file: the `## path/to/file` section of the `brain/codemap/*.md` sheet named in the index, then the code.
4. Routine change: the recipe in `brain/playbooks/`.

### Zone rules
`apps/web/CLAUDE.md`, `apps/api/CLAUDE.md`, `apps/api/scripts/CLAUDE.md` and `packages/shared/CLAUDE.md` import their `AGENTS.md` and load automatically when you work in those folders. Keep zone-specific rules there, not in the root files.

### The brain is the project memory
- Every durable fact about the project (decision, convention, state, bug, vocabulary) goes into `brain/`, never into personal auto-memory, which only keeps the user's own preferences.
- `brain/INDEX.md` is **generated**: after any file creation, deletion or rename, update the codemap sheet then run `python brain/codemap/build-index.py`.
- The brain is in English. Answer the user in their language.

### `Stop` hook (safety net)
`.claude/settings.json` runs `.claude/hooks/check-changelog.sh` at the end of each turn. It blocks once:
- if uncommitted code is newer than the latest `brain/changelog/` entry;
- otherwise, if a repository file has no section in `brain/codemap/` (it lists the files).

When everything is documented, it silently regenerates `brain/INDEX.md`. Do not rely on it: write the changelog entry and the codemap section yourself (AGENTS.md §2). If the block is about changes you did not make, say so and finish.

### UI and design
- Skill sequence (through the Skill tool): `ui-ux-pro-max` → `frontend-design` (or `impeccable`) → `design-taste-frontend` → `web-design-guidelines`. No JSX/CSS before steps 1 to 3.
- Design skills look for `DESIGN.md` / `PRODUCT.md` at the root: give them `brain/design/design-system.md` and `brain/design/product.md` explicitly.
- Code comments cite the visual contract as `brain/design/design-system.md section N`: keep them in sync if its sections are renumbered.

### Tools and environment
- **Subagents**: hand them the relevant `brain/codemap/*.md`, `brain/features/*.md` and `brain/playbooks/*.md` instead of letting them re-read code blindly.
- **Windows shells**: prefer the Bash tool (Git Bash) for git, heredocs and scripts. PowerShell 5.1 has no `&&` / `||` and mangles double quotes in commit messages.
- **MCP server `dive`** (`.mcp.json`): needs `apps/mcp/.env` (copy of `.env.example` with a service account) and a running API.
- **Attribution**: end commits with the `Co-Authored-By` line provided by the tool and PRs with the Claude Code attribution line.
