# Step 0: STATUS no longer says the corner chamfers are locked at 45°

> The project snapshot `brain/STATUS.md` was corrected: the BF1 = LF1 / BF2 = LF2 relations are normal, switchable relations again, not a permanent lock.

**Brief**: `brain/briefs/2026-09-30-chamber-spiral-and-optimisation-fixes.md` item 9 (first part) · **Spec**: none (docs fix) · **Branch**: `docs/status-bf-relations` · **PR**: not opened (no GitHub CLI on the workstation; open it from https://github.com/Bapteds/dive-gui/pull/new/docs/status-bf-relations)

## What changed
On 2026-09-30 the corner chamfers were briefly forced to 45° (BF1 always equal to LF1, BF2 always equal to LF2), then that lock was reverted the same day. `STATUS.md` still described the lock as permanent, so any agent reading it at the start of a session would have believed the wrong thing. Only the text changed; no code, no geometry.

## Example
In the Chamber page, open "Configure relations (n/9 on)": the two relations "BF1 = LF1" and "BF2 = LF2" are ticked by default and can be unticked. With "BF1 = LF1" unticked, typing BF1 Exact 300 mm while LF1 is 400 mm builds a 300 × 400 mm corner cut.

**Explanation**: the relation only ties the two values while it is on; once off, BF1 takes its own Min / Max / Exact like any other row, so the chamfer is no longer 45°.

## How to use it
Nothing to do in the app: this was a documentation fix. Read `brain/STATUS.md` §1 for the current state.
