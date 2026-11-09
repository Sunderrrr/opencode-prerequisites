# {{name}} — agent rules

Global rules (delegation, validation, git) come from `~/.config/opencode/AGENTS.md`.
This file adds the design and frontend rules for this project.

## Commands

- Dev server: `npm run dev`
- Typecheck: `npm run typecheck`
- Build: `npm run build` (`tsc --noEmit && vite build`)
- Preview the build: `npm run preview`
- E2E: `npx playwright install chromium` once, then `npm run test:e2e`

## Design system

- Tokens live in `src/styles/tokens.css`. Tailwind utilities are mapped in
  `src/styles/global.css` with `@theme inline`.
- Never hard-code a color, spacing, radius, font size or shadow in a component.
  Use the token variable (`var(--ds-color-ink)`) or its utility (`text-ink`,
  `bg-surface`, `rounded-lg`, `text-4xl`, `shadow-card`).
- Add a token first, then use it. Update both themes: colors use
  `light-dark(light, dark)` and follow `:root[data-theme]`.
- Headings use `font-display`; body text uses `font-sans`; code and labels use
  `font-mono`. Keep one `h1` per page and a logical heading order.

## Accessibility (WCAG 2.2 AA)

- Contrast: at least 4.5:1 for body text, 3:1 for large text and essential UI
  boundaries. Check light and dark themes before shipping.
- Keyboard: every interactive element reachable in a logical order, visible
  `:focus-visible` ring, no keyboard trap.
- Semantics: landmarks (`header`, `main`, `footer`), labels on every control,
  alt text on images, `aria-live` for status that changes without navigation.
- Never convey information by color alone. Respect `prefers-reduced-motion`
  (`global.css` already disables animations and transitions).
- Tap targets are at least 44×44 px on mobile. Test at 200% zoom.

## Visual checks

- Take screenshots at 375, 768, 1024 and 1440 px wide, in light and dark:
  `page.setViewportSize({ width, height: 900 })` then `page.screenshot()`.
- Check for horizontal overflow, clipped text, overlapping elements and
  inconsistent spacing at each width.

## Dependencies

- Run `oc-versions npm <package>` before adding or upgrading a dependency, then
  pin the exact version (no `^`, `~`, `latest` or `*`).
- After an upgrade, run `npm run build` and `npm run test:e2e`, and update this
  file if a command changes.

## Scope

- This is a web project: the Android toolchain (`oc-android`) is not relevant.
  Use Playwright (and the browser devtools) for functional and visual checks.
