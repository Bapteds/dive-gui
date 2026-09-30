# Features: index

> One sheet per feature, end to end (UI → API → services → tools → storage). Template: `_FORMAT.md`.
> To locate a specific file: `brain/INDEX.md`. For step-by-step changes: `brain/playbooks/`.

## Platform

| Sheet | Feature | Where in the UI |
|---|---|---|
| `auth-and-accounts.md` | JWT login, session, self-service account, password change | `/login`, `/account` |
| `admin-and-audit.md` | Account back office (protected super-admin), disabling, deletion, audit log | `/admin` |
| `projects.md` | Projects, visibility, collaborators, detail page and its tabs | `/projects`, `/projects/:id` |
| `dashboard.md` | "Command center" Home: server metrics, running jobs, recent projects | `/` |
| `terminal.md` | Project shell over WebSocket (disabled by default) | project Terminal button |
| `mcp-server.md` | MCP server exposing the API as tools for Claude | `apps/mcp`, `.mcp.json` |

## CFD workflow (per project)

| Sheet | Feature | Where in the UI |
|---|---|---|
| `case-files.md` | Case import, tree + editor (Easy/Advanced), verify/scaffold, download, reset, summary | Case files tab, `/projects/:id/edit` |
| `templates.md` | Case-file templates (tags, inline, applying to a project) | `/templates`, Case files |
| `mesh-library-and-conversion.md` | Mesh library, CGNS/Fluent → Foam conversion, 3D viewer, patches, autoPatch, backup | Case files (conversion), Merge meshes / Assemble (library), Visualize tab |
| `merge-and-assembly.md` | Conformal merge, multi-part 3D assembly, non-conformal coupling, disassemble | Merge meshes, Assemble tab |
| `boundary-conditions.md` | Boundary conditions per object type, MRF / Moving Rotor, draft-tube CSV | Case files → Boundary conditions |
| `solver-and-runs.md` | Solver catalog, setup, Easy/Advanced config, turbulence, TopoSet, serial/MPI runs, live residuals | Solver tab |
| `free-surface.md` | Free surface from a rigid-lid run, lid iteration by remeshing (lidIterationKit), mesh origin | Free surface tab |
| `export-cfdpost.md` | OpenFOAM → transient CGNS export for Ansys CFD-Post | Export tab |

## Standalone tools

| Sheet | Feature | Where in the UI |
|---|---|---|
| `meshing.md` | Meshing sessions STL/FMS → snappyHexMesh or cfMesh → polyMesh | `/meshing`, `/meshing/:id` |
| `chamber-creation.md` | Parametric chamber generator (CadQuery), OpenFOAM patches, exports, saves, send to Meshing | `/chamber` |

## Coming next (specified, not integrated)

- **Semi-spiral tool**: semi-spiral casing computed from 7 inputs (6 spiral segments + 3 tongue segments). Spec and reference implementation in `documents/Semi-spiral-creation/`. Planned integration into Chamber Creation, not started.

## Adding a feature

Create `brain/features/<name>.md` following `_FORMAT.md`, add its line here, and reference its spec (`brain/specs/…`).
