# Upstream provenance — ui-ux-pro-max

Vendored from [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
at commit `11ca2b3bdd555649f278ee348c32a9302b24dcf1` (2026-11-27, release line
`v2.15.0`; version 2.15.0 from `skill.json`, MIT, copyright Next Level Builder).

- Upstream skill directory: `.claude/skills/ui-ux-pro-max/`
- Vendored on: 2026-11-28
- License: MIT — see `LICENSE`
- Local launcher: `config/bin/oc-uiux-search`
- Vendored files: 46 (44 upstream skill files + `LICENSE` + this `UPSTREAM.md`),
  about 2.1 MB.

## Vendored files

- `SKILL.md` — all 15 `python scripts/search.py` invocations replaced by
  `oc-uiux-search`; no `.claude/` path or `CLAUDE_PLUGIN_ROOT` left.
- `LICENSE`
- `references/pro-rules.md`, `references/quick-reference.md`
- `scripts/search.py`, `scripts/core.py`, `scripts/design_system.py`,
  `scripts/reasoning_contract.py`, `scripts/preview.py`
- `data/` (13 CSVs): `app-interface.csv`, `charts.csv`, `colors.csv`, `google-fonts.csv`,
  `icons.csv`, `landing.csv`, `motion.csv`, `products.csv`, `react-performance.csv`,
  `styles.csv`, `typography.csv`, `ui-reasoning.csv`, `ux-guidelines.csv`
- `data/stacks/` (23 CSVs): `angular.csv`, `astro.csv`, `avalonia.csv`, `flutter.csv`,
  `html-tailwind.csv`, `javafx.csv`, `jetpack-compose.csv`, `laravel.csv`, `nextjs.csv`,
  `nuxtjs.csv`, `nuxt-ui.csv`, `pyside6-qss.csv`, `react.csv`, `react-native.csv`,
  `shadcn.csv`, `svelte.csv`, `swiftui.csv`, `threejs.csv`, `uno.csv`, `uwp.csv`,
  `vue.csv`, `winui.csv`, `wpf.csv`

Excluded upstream files: `scripts/tests/`, `scripts/validate_data.py`,
`data/phosphor-icons-upstream.json`, `data/google-font-licenses.json`,
`data/data-provenance.json`, `data/catalog-summary.json`.

## Refresh of 2026-11-28

The previous vendor pin was `4f2dbb67e64969a9a30ab00742f2d55d66ddec2b`. This refresh moves
to `11ca2b3bdd555649f278ee348c32a9302b24dcf1` (35 upstream commits) and adds:

- **23rd stack: `pyside6-qss`** — PySide6 / Qt Widgets with QSS and `qfluentwidgets`
  (theme setup, per-widget styling, layout spacing and size policies).
- **`scripts/preview.py`** — `--preview` (with `--design-system`) renders a
  self-contained `preview.html`: inline CSS, no JS framework and no Tailwind CDN.
  Google Fonts are linked when the pairing provides a URL; system-font fallbacks keep
  the page readable offline. With `--persist` the file lands next to `MASTER.md`,
  otherwise `--output-dir` controls the destination (or a temp path is printed).
- **`--tokens dtcg|css`** — prints a W3C Design Tokens Community Group JSON document
  (`$value` / `$type`, with a `semantic` layer) or `:root` CSS custom properties.
  With `--persist`, writes `tokens.json` (and `tokens.css` for the CSS form) next to
  `MASTER.md`; existing files follow the same `--force` / skip rules.
- Searchable data now reports 194 product palettes, 141 UX guidelines and 20 GSAP
  presets (80 styles, 74 font pairings, 105 icons and 25 chart types unchanged),
  and `SKILL.md` carries 15 runnable examples instead of 11.

## Security and execution

`scripts/search.py`, `scripts/design_system.py` and `scripts/preview.py` are third-party code
executed locally by `oc-uiux-search`. They use the Python 3 standard library only,
read the CSV files under `data/`, and make no network request. Only `search.py` is
executed; the upstream installers (`npx ui-ux-pro-max-cli`, plugin setup) are not
vendored and must not be run. The generated preview HTML links Google Fonts when the
chosen pairing supplies a URL, but generating it makes no request.

`DATA_DIR` in `scripts/core.py` is `Path(__file__).parent.parent / "data"`: the data
directory is resolved relative to the script, so the skill is relocatable.

## `--persist`

With `--design-system --persist`, the tool writes `design-system/<project-slug>/MASTER.md`
(and optionally `pages/<page>.md`) relative to the current working directory by default.
Always pass `--output-dir "<project-root>"` so files land in the project instead of the
shell's cwd. Without `--force`, an existing `MASTER.md` is left untouched.

## KIT-PATCH (2026-11-28)

One local code change differs from upstream `11ca2b3`: in `scripts/design_system.py`,
`DesignSystemGenerator.generate()` forwards the explicit `direction` argument to both
`resolve_preview_locale()` calls (query and project-name inference). Rationale: locale
resolution should see the same explicit direction as the final recommendation, rather
than resolving it a second time from the text alone. No other code differs.
