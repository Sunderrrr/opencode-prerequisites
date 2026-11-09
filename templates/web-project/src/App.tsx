import { useState } from "react"
import { useTheme } from "./useTheme"

const swatches = [
  { label: "Canvas", className: "bg-canvas" },
  { label: "Surface", className: "bg-surface" },
  { label: "Primary", className: "bg-primary" },
] as const

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z" />
    </svg>
  )
}

export default function App() {
  const { theme, toggle } = useTheme()
  const [clicks, setClicks] = useState(0)

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-card"
      >
        Skip to content
      </a>

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-6 sm:px-8">
        <p
          className="min-w-0 truncate font-mono text-xs font-medium uppercase tracking-[0.18em] text-ink-muted"
          title="{{name}}"
        >
          {{name}}
        </p>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={theme === "dark"}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-200 hover:bg-surface-muted"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          <span aria-hidden="true">{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8">
        <section className="grid gap-12 py-10 md:grid-cols-[1.1fr_0.9fr] md:items-center md:py-16 lg:py-20">
          <div>
            <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
              Design-system starter
            </p>
            <h1 className="mt-5 max-w-[16ch] text-4xl text-balance sm:text-5xl lg:text-6xl">
              Build a clear, accessible interface.
            </h1>
            <p className="mt-6 max-w-[52ch] text-lg text-ink-muted">
              React, TypeScript and Tailwind CSS wired to one set of design tokens.
              Change the tokens once and the whole page follows — in light and dark.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setClicks((current) => current + 1)}
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-on-primary transition-colors duration-200 hover:bg-primary-hover"
              >
                Try the interaction
              </button>
              <a
                href="#tokens"
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-5 text-sm font-medium text-ink underline decoration-1 underline-offset-4 transition-colors duration-200 hover:bg-surface-muted"
              >
                Inspect the tokens
              </a>
            </div>

            <p
              role="status"
              aria-live="polite"
              className="mt-4 min-h-6 text-sm text-ink-muted"
            >
              {clicks === 0
                ? "The button updates this live region."
                : `Clicked ${clicks} ${clicks === 1 ? "time" : "times"}.`}
            </p>
          </div>

          <section
            id="tokens"
            aria-labelledby="tokens-title"
            className="rounded-lg border border-line bg-surface p-6 shadow-card sm:p-8"
          >
            <h2 id="tokens-title" className="text-2xl">
              Tokens at a glance
            </h2>
            <p className="mt-2 text-sm text-ink-muted">
              Every value comes from{" "}
              <code className="rounded-sm bg-surface-muted px-1.5 py-0.5 text-xs">
                src/styles/tokens.css
              </code>
              .
            </p>

            <ul className="mt-6 grid grid-cols-3 gap-3" aria-label="Color tokens">
              {swatches.map((swatch) => (
                <li key={swatch.label}>
                  <span
                    aria-hidden="true"
                    className={`block h-12 rounded-md border border-line ${swatch.className}`}
                  />
                  <span className="mt-2 block text-xs font-medium text-ink-muted">
                    {swatch.label}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-6 space-y-3 border-t border-line pt-5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Radius</dt>
                <dd className="flex items-center gap-2" aria-hidden="true">
                  <span className="size-3 rounded-sm bg-surface-muted ring-1 ring-line" />
                  <span className="size-3 rounded-md bg-surface-muted ring-1 ring-line" />
                  <span className="size-3 rounded-full bg-surface-muted ring-1 ring-line" />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Spacing</dt>
                <dd className="flex items-end gap-1" aria-hidden="true">
                  <span className="h-2 w-1 rounded-sm bg-primary/40" />
                  <span className="h-2 w-2 rounded-sm bg-primary/60" />
                  <span className="h-2 w-4 rounded-sm bg-primary" />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-ink-muted">Type</dt>
                <dd className="font-display text-2xl leading-none">Aa</dd>
              </div>
            </dl>
          </section>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-6 text-sm text-ink-muted sm:px-8">
          <p>
            Edit <code className="font-mono text-xs text-ink">src/App.tsx</code> to begin.
          </p>
          <p className="font-mono text-xs">Vite · React · TypeScript · Tailwind</p>
        </div>
      </footer>
    </div>
  )
}
