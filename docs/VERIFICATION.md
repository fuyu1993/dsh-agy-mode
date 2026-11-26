# Verification

Checked against this machine's installation on 2026-11-26 (dsh 0.2.2-rc.5 via
Desktop, profile `desktop`, `agy` 1.5.17).

## What was run

| Check | Result |
|---|---|
| Bundle installs into the profile (`plugin_manager` `install_bundle`) | `application: applied`; package linked at `~/.dsh/profiles/desktop/node_modules/dsh-agy-mode` |
| `preset-agy` row is active | `list_plugins` at `offset: 200` shows `include:preset-agy`, `fiberPhase: active` |
| Declaration reaches the Loader with a schema | `Config.listConfigs` lists `include:preset-agy` with `status: schema` |
| Whole profile still composes with the new rows | A copy of the profile dumped with `dsh --profile <copy> --dump-config` contains the `dsh-agy-mode` section, `preset-agy`, and the `agy-planner` child at the end of the preset's plugin list |
| Patch structure | 1 inserted row, preset `agy`, order 5, 24 child rows, no duplicate child ids |
| Every child package resolves from the installation | 28 package names checked with `require.resolve`; all resolve |
| Every child `config` key exists in the installed package | checked for plan-mode, skill-filesystem, tool-fs, tool-pruner, tool-todo, tool-web, subagent, workflow-ptc, agent-instructions, tool-fs-search |
| Plugin module syntax | `node --check index.js` clean |
| Plugin behaviour against the real CLI | see below |

## Plugin behaviour (stub Host services, real `agy`)

- `agy_models` returned 27 model ids and the five efforts.
- `agy_consult` with `model: gemini-3.8-flash-low`, `effort: low` returned the
  expected one-line answer, reporting back the model and effort it used.
- The delegation guard refused `subagent` before any budget was recorded,
  allowed it under `{ allow: true, maxChildren: 2, maxDepth: 1 }`, refused a
  child at depth 1, and refused everything after `allow: false`.
- Unrelated tools were never blocked by the guard.

## Not verified

- The rendered mode name, description and icon in the Web UI's mode picker:
  they need a page reload after the Host picked up the bundle, and the picker
  was not driven in a browser here.
- A live conversation running the whole loop (ask → plan with agy → implement →
  review with agy): that needs a new session created with this mode selected.
- `agy` was signed in on this machine. A signed-out CLI is reported as advice
  rather than an empty answer, but that path was not exercised end to end.
