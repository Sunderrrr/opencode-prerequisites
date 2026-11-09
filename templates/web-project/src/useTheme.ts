import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark"

// Must match the inline script in index.html.
const STORAGE_KEY = "oc-web-theme"

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "light" || value === "dark" ? value : null
  } catch {
    // Storage can be unavailable (private mode, blocked cookies).
    return null
  }
}

/**
 * Theme state with a saved preference and an OS fallback.
 * Without a saved preference the page follows prefers-color-scheme live;
 * toggling persists an explicit choice.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [preference, setPreference] = useState<Theme | null>(storedTheme)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const theme = preference ?? system

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event: MediaQueryListEvent) => {
      setSystem(event.matches ? "dark" : "light")
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark"
    setPreference(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // The visual state still changes for this session.
    }
  }, [theme])

  return { theme, toggle }
}
