# Workflow

> How an agent carries a task end to end in this repository. These rules come from the practices observed in the history (≈ 340 commits, 2 developers) and from the user's instructions.

## 1. Session protocol

1. **Start**: read `brain/STATUS.md` (current state, open threads, pending questions) then the current month's changelog (`brain/changelog/YYYY-MM.md`, top entries).
2. **Target**: identify the relevant `brain/features/*.md` sheets and `brain/codemap/*.md` sections (via `brain/INDEX.md`). For a routine change, open the matching `brain/playbooks/*.md`. Only read code once the area is located.
3. **Work** following the cycle in §2.
4. **Close** (mandatory, even for a small fix):
   - entry in `brain/changelog/YYYY-MM.md` (format: `brain/changelog/README.md`);
   - codemap update if a file was created, deleted, renamed or an export changed role, then `python brain/codemap/build-index.py`;
   - feature sheet update if the visible behavior or the business rules changed;
   - `brain/STATUS.md` update if the current state, open threads or verification changed;
   - `brain/known-issues.md` update if a known bug was fixed or a new one found;
   - playbook or zone `AGENTS.md` update if a procedure or an area rule changed.

## 2. Cycle of a non-trivial feature or fix

1. **Brainstorm** with the user: **one question at a time**, until ambiguities are gone.
2. **Spec** written BEFORE implementing: `brain/specs/YYYY-MM-DD-<topic>-design.md` (goal, changes, out of scope, tests). Status `approved` once validated.
3. **Implementation plan** for big topics: `brain/plans/YYYY-MM-DD-<topic>.md` (ordered tasks, files, tests).
4. **Test-first**: write or adapt the failing test, then implement.
5. **Verify**: targeted suites + typecheck (see `brain/conventions/testing.md`). Rebuild `@dive/shared` first if `packages/shared` changed.
6. **Document**: closing steps of §1.
7. **Commit + push** per feature, only if the user asked for it or it is the agreed rule for the current branch.

For a small, obvious fix: skip brainstorm / spec / plan, keep test + verification + changelog.

## 3. Cross-cutting rules

- **Do not implement what was not asked.** The "open threads" of `STATUS.md` and `known-issues.md` are proposals, not tasks.
- **Geometry change** (`apps/api/scripts/buildChamber.py`) ⇒ **purge the cache** `apps/api/storage/chamber/*` (cache keyed on parameters, not code) and say so in the changelog.
- **Visible rename** ⇒ display only: keys, enums, saves and cache do not move (see `brain/conventions/vocabulary.md`).
- **Gen Dim v3 model**: if the workbook `documents/Gen Dim v3 Only Calculator (standalone).xlsx` changes, `computeChamberGeneratorDims` (`packages/shared`) and the parity tests (`apps/api/tests/chamberModel.test.ts`, `apps/web/src/features/chamber/chamberForm.test.ts`) move with it.
- **UI**: follow `apps/web/AGENTS.md` and `brain/conventions/frontend.md` (skill sequence + design system) before any JSX/CSS.
- **Security**: no committed secret (`apps/api/.env`, `apps/mcp/.env` are ignored); every external command as argv (`execFile`/`spawn`), never an interpolated shell; paths confined through the helpers of `apps/api/src/lib/caseStorage.ts` / `fileTreeStorage.ts`.
- **Deployment server**: anything that depends on OpenFOAM, ParaView, `/proc` or h5py cannot run on a Windows workstation; flag it "to validate on the Debian server" in the changelog.

## 4. Git and GitHub

- Repository: `github.com/Bapteds/dive-gui`, default branch `main`. Never commit directly on `main`: create a branch.
- Branches: `feat/<topic>`, `fix/<topic>`, `docs/<topic>` (e.g. `feat/chamber-ui-feedback`, `fix/bugs-v1.0.1`). Integration through Pull Requests.
- Commit messages: **Conventional Commits** in English with an area scope: `feat(chamber): …`, `fix(solver): …`, `docs(meshing): …`, `refactor(mesh): …`, `test(meshing): …`. Common scopes: `chamber`, `meshing`, `mesh`, `solver`, `export`, `bc`, `case`, `runs`, `dashboard`, `web`, `api`, `convert`, `brain`.
- Specs and plans are committed in a separate `docs:` commit, BEFORE the implementation commit.
- End commit messages with the `Co-Authored-By` line provided by the tool; end PR descriptions with the Claude Code attribution line.
- PowerShell 5.1 mangles double quotes in `git commit -m`: commit through Bash (heredoc) and check `git log` afterwards.
- `gh` can hang when it reads stdin: append `< /dev/null` in scripts.

## 5. Languages

| Medium | Language |
|---|---|
| Code, comments, commit messages, UI strings | English |
| Brain (`brain/**`), zone `AGENTS.md`, specs and plans | English |
| Changelog entries written before 2026-09-28 | French (history, not translated) |
| Conversation with the user | The user's language |
