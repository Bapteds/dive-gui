# Playbooks: index

> Step-by-step recipes for the routine changes of this codebase. Each one names the real files and functions to copy, the checks to run and the brain files to update.
> Verified against the code on 2026-09-28. **If a step no longer matches the code, fix the playbook in the same change.**

| Playbook | Use it to… |
|---|---|
| `add-api-endpoint.md` | Add a REST route (existing or new module): schema, controller, service, guards, error codes, web client + query hook, tests, MCP tool |
| `add-prisma-migration.md` | Change the database schema: `schema.prisma`, migration, seed, test DB, deployment |
| `add-env-var.md` | Add or change an API or web setting: `config/env.ts`, `.env.example`, tests, deployment |
| `integrate-external-tool.md` | Run an OpenFOAM utility or a bundled Python script from the API (argv, step reports, `OK:`/`KO:` contract, fake runners) |
| `add-web-page-or-tab.md` | Add a page, a navigation entry or a project-detail tab, with data hooks, states and tests |
| `add-solver-or-turbulence-model.md` | Extend the solver catalog or the turbulence models (shared catalog, scaffold, wizard) |
| `change-chamber-geometry.md` | Modify `buildChamber.py` safely (patches, refusals, exports, geometry suite, cache purge) |
| `add-chamber-input-or-parameter.md` | Add a chamber input, option or derived parameter end to end (shared model, API, builder, form, saves) |
| `deploy-and-update.md` | Update the Debian production server, verify, roll back |

Each playbook follows the same outline: **Before you start** → **Steps** → **Verify** → **Update the brain** → **Pitfalls**.
