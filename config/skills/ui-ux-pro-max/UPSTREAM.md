# Upstream provenance — ui-ux-pro-max

Vendored from [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
at commit `4f2dbb67e64969a9a30ab00742f2d55d66ddec2b` (version 2.15.0, MIT, copyright Next Level Builder).

- Upstream skill directory: `.claude/skills/ui-ux-pro-max/`
- Vendored on: 2026-11-08
- License: MIT — see `LICENSE`
- Local launcher: `config/bin/oc-uiux-search`

## Vendored files

- `SKILL.md` — all 11 `CLAUDE_PLUGIN_ROOT`-based script invocations replaced by
  `oc-uiux-search`; no `.claude/` path left.
- `LICENSE`
- `references/pro-rules.md`, `references/quick-reference.md`
- `scripts/search.py`, `scripts/core.py`, `scripts/design_system.py`, `scripts/reasoning_contract.py`
- `data/` (13 CSVs): `app-interface.csv`, `charts.csv`, `colors.csv`, `google-fonts.csv`,
  `icons.csv`, `landing.csv`, `motion.csv`, `products.csv`, `react-performance.csv`,
  `styles.csv`, `typography.csv`, `ui-reasoning.csv`, `ux-guidelines.csv`
- `data/stacks/` (22 CSVs): `angular.csv`, `astro.csv`, `avalonia.csv`, `flutter.csv`,
  `html-tailwind.csv`, `javafx.csv`, `jetpack-compose.csv`, `laravel.csv`, `nextjs.csv`,
  `nuxtjs.csv`, `nuxt-ui.csv`, `react.csv`, `react-native.csv`, `shadcn.csv`, `svelte.csv`,
  `swiftui.csv`, `threejs.csv`, `uno.csv`, `uwp.csv`, `vue.csv`, `winui.csv`, `wpf.csv`

Excluded upstream files: `scripts/tests/`, `scripts/validate_data.py`,
`data/phosphor-icons-upstream.json`, `data/google-font-licenses.json`,
`data/data-provenance.json`, `data/catalog-summary.json`.

## Security and execution

`scripts/search.py` and its sibling modules are third-party code executed locally by
`oc-uiux-search`. They use the Python 3 standard library only, read the CSV files under
`data/`, and make no network request. Only `search.py` is executed; the upstream installers
(`npx ui-ux-pro-max-cli`, plugin setup) are not vendored and must not be run.

`DATA_DIR` in `scripts/core.py` is `Path(__file__).parent.parent / "data"`: the data
directory is resolved relative to the script, so the skill is relocatable.

## `--persist`

With `--design-system --persist`, the tool writes `design-system/<project-slug>/MASTER.md`
(and optionally `pages/<page>.md`) relative to the current working directory by default.
Always pass `--output-dir "<project-root>"` so files land in the project instead of the
shell's cwd. Without `--force`, an existing `MASTER.md` is left untouched.
