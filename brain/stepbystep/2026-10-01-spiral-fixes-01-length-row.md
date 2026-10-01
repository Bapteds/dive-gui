# Item 2: Length is one row of the Parameters table, with Min / Max / Exact, with or without the spiral

> The chamber Length moved from a form field into the Parameters table, where it defaults to 2 × B Kammer and accepts Min / Max / Exact like every other dimension, in both modes.

**Brief**: `brain/briefs/2026-09-30-chamber-spiral-and-optimisation-fixes.md` item 2 · **Spec**: `brain/specs/2026-10-01-chamber-length-row-design.md` · **Branch**: `feat/chamber-length-row` · **PR**: not opened (no GitHub CLI on the workstation; open it from https://github.com/Bapteds/dive-gui/pull/new/feat/chamber-length-row)

## What changed
Before, the Length had two different controls. Without the semi-spiral it was a "Length (mm)" box in the form: blank meant 2 × B Kammer, a number forced the length, and there was no way to say "at most" or "at least". With the spiral it was a separate row in the table.

Now there is one Length row in the Parameters table, right under B Kammer, in both modes:
- its default is 2 × B Kammer (shown as the status "= 2 × B Kammer"); this link is always on and is not in "Configure relations";
- Min, Max and Exact work exactly as on the other rows (statuses `capped at max`, `raised to min`, `set exact`, `! min>max`);
- it has no confidence value ("-"), because it is not an empirical fit;
- with the semi-spiral on, nothing changes compared with yesterday: the Max limits the spiral, the Min lengthens the inlet channel, and the Final shows the spiral's real length.

Old saves still load: a saved "Length (mm)" value becomes a Length Exact, and a saved spiral Length Min / Max / Exact comes back as it was. The geometry and the cache keys of existing builds do not change.

Length can also be ticked as a parameter in an optimisation study, for designs without the spiral (with the spiral it comes with item 1).

## Example
Runner Ø 1450 mm, Head 7.85 m, Q_max 8 m³/s: B Kammer comes out at 4450 mm, so the Length row shows 8900 mm with the status "= 2 × B Kammer". Type 8000 in the Length **Max** cell: the Final becomes 8000 and the status "capped at max". Generate builds an 8000 mm long box.

**Explanation**: the default 2 × 4450 = 8900 mm is larger than the Max you typed, so the Max wins and clamps it, exactly like a Max on any other row. Before this change you could only force an exact length; a Max ("no longer than 8000 mm, but shorter if B Kammer gets smaller") was not possible without the spiral.

## How to use it
Chamber page → **Parameters** table → row **Length** (under B Kammer): type Min, Max or Exact; clear the cell to go back to 2 × B Kammer. The old "Length (mm)" field in the left-hand form is gone.
In a project's **Optimisation** tab → New study → tick **Length** (base design without Semi-spiral casing).
