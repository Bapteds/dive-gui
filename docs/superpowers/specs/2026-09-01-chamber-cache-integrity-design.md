# Chamber build-cache integrity: atomic writes + per-hash lock — design

**Date:** 2026-09-01
**Status:** approved (batch 1 of the chamber review: findings 1–4)

## Problems fixed

1. A build killed mid-write (timeout/crash) leaves `chamber.glb` on disk while
   later artifacts are missing/truncated; since "GLB exists" means "cached",
   every later identical build returns 200 with broken artifacts, forever.
2. No lock anywhere: two concurrent identical builds (or STEP downloads) run
   two builders into the SAME hash directory with interleaved writes.
3. The deferred-STEP `--step` re-run rewrites `chamber.glb`/`manifest.json`/
   exports in place while they may be concurrently served; a mid-write reader
   gets truncated bytes, and a killed re-run destroys a good cached build.
4. `mirrorStep.py` uses the fixed temp name `<dst>.tmp`, so two concurrent
   mirror requests share one temp file.

## Fix A — builder writes atomically, GLB promoted last (`buildChamber.py`)

Every artifact is written to `<final>.tmp` in the same directory and
`os.replace()`d onto its final name (rename is atomic on the same volume):
`edges.bin`, `manifest.json`, `exports/chamber.stl`, `exports/chamber.step`,
`build-meta.json`, `exports/trisurface.zip`. Exporters that infer format from
the extension get it passed explicitly (`file_type="glb"/"stl"`,
`exportType="STL"/"STEP"`).

`chamber.glb` is special: it is the service's cache-completeness marker, so it
is exported to `chamber.glb.tmp` at the same point in the pipeline as today but
**promoted last**, immediately before the `OK:` line — after every other
artifact is in place. Consequences:

- A killed/crashed build leaves NO `chamber.glb` → the next identical request
  simply rebuilds (stale `.tmp` and partial artifacts are overwritten). The
  permanently-poisoned-cache state becomes unreachable.
- A `--step` re-run replaces each served artifact atomically: a concurrent
  reader always gets a complete old or complete new file, never a truncation.
  (On Windows `os.replace` onto a file held open by a reader can fail with a
  sharing violation — a transient 502 on an extremely narrow window, strictly
  better than serving truncated bytes; POSIX is unaffected.)

Fixed `.tmp` names (not mkstemp) are deliberate: same-hash runs are serialized
by Fix B, and a retry after a crash overwrites the leftovers instead of
accumulating them.

## Fix B — per-hash in-flight lock (`chamber.service.ts`)

A module-level `Map<hash, Promise>` promise-chain mutex:

```
withChamberLock(hash, fn): waits for the previous holder (success or failure),
runs fn, and deletes the map entry when the queue drains.
```

Wrapped around, with the state re-checked INSIDE the lock:

- `buildChamber()`: the `chamberGlbExists` cache check + the builder run. Two
  concurrent identical Generates → one build; the second takes the cache path.
- `getChamberExport()` for `step` / `stepMirrored`: the artifact re-read + the
  generation (`generateStep` / `generateMirroredStep` themselves stay
  lock-free; locking happens only at the entry points, so the mirror's
  generate-STEP-first path nests without deadlock).

Doubled clicks now cost one tool run; a build and a `--step` re-run of the same
hash can no longer overlap. Reads (geometry/manifest/edges/exports) stay
lock-free — safe once every write is atomic (Fix A). Single-process scope: the
lock is in-process, like the rest of the app's state; multi-instance
deployments are out of scope.

The stale docstring ("a concurrent first click at worst re-runs it
harmlessly") is corrected to describe the lock.

## Fix C — unique temp file in `mirrorStep.py`

`tempfile.mkstemp(dir=dirname(dst), suffix=".step.tmp")` instead of
`dst + ".tmp"`; export with `exportType="STEP"`, `os.replace` onto `dst`,
temp removed on any failure. Concurrent CLI invocations (defense in depth —
the service already serializes them) can no longer cross-promote or delete
each other's half-written files.

## Tests

- **API (fake runners with a short async delay + invocation counters):**
  two concurrent `POST /build` with identical params → the builder runs ONCE,
  both get 200 and the same hash; two concurrent `GET /export/step` on a
  deferred vane build → one `--step` run, both 200; two concurrent
  `GET /export/stepMirrored` → one `--step` run + one mirror run, both 200.
  Existing sequential suites must pass unchanged (the lock is transparent).
- **Geometry (pytest):** after a successful build (plain and `--step`) no
  `*.tmp` files remain anywhere under the output directory, and `chamber.glb`
  exists; the existing 19 tests stay green (artifact contents unchanged).
  The mirror failure test keeps asserting no output file is left behind.

## Out of scope

- Cross-process locking (multi-instance API deployments).
- Repairing pre-existing poisoned cache directories (delete manually if any).
- The review's other batches (input floors, blade-radius fit bound, UX).
