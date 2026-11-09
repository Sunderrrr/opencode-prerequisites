# {{name}}

Vite + React + TypeScript + Tailwind CSS v4 starter with a token-based design
system, light/dark themes and an accessible demo page.

## Quick start

```bash
npm install
npm run dev
```

The dev server prints its URL (default <http://localhost:5173>).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm run build` | Typecheck, then production build in `dist/` |
| `npm run preview` | Serve the production build (port 4173) |
| `npm run test:e2e` | Playwright smoke tests (starts the dev server) |
| `npm run test:e2e:ui` | Playwright interactive UI mode |

Install the browser once before the E2E tests:

```bash
npx playwright install chromium
```

## Design system

- `src/styles/tokens.css` — color, spacing, radius, typography, elevation and
  motion tokens. Colors use `light-dark(light, dark)`.
- `src/styles/global.css` — Tailwind import, `@theme inline` mapping of the
  tokens to utilities (`bg-surface`, `text-ink-muted`, `rounded-lg`, …), base
  styles and reduced-motion handling.
- `src/useTheme.ts` — saved preference with a live `prefers-color-scheme`
  fallback. The inline script in `index.html` applies the theme before first
  paint to avoid a flash.
- Components use utilities, never raw values. Add a token, map it in
  `@theme inline`, then use it.

## Accessibility

The demo page includes a skip link, landmarks, visible focus rings, a labelled
theme toggle with `aria-pressed`, a 44 px minimum target size, and a `role="status"`
live region. Contrast targets WCAG 2.2 AA in both themes; reduced motion is
honoured globally.

## Structure

```
index.html
playwright.config.ts
public/favicon.svg
src/
  App.tsx
  main.tsx
  useTheme.ts
  styles/
    global.css
    tokens.css
tests/e2e.spec.ts
```

## Versions

Every dependency is pinned to an exact version. Before adding or upgrading one,
run `oc-versions npm <package>` and update `package.json` deliberately; then run
`npm run build` and `npm run test:e2e`.
