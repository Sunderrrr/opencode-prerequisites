import { expect, test, type Page } from "@playwright/test"

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

test("renders the starter page without console errors", async ({ page }) => {
  const errors = collectErrors(page)

  await page.goto("/")
  await expect(page).toHaveTitle("{{name}}")
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Try the interaction" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /switch to .* theme/i })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("live region")

  expect(errors).toEqual([])
})

test("the primary button updates the live region", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Try the interaction" }).click()
  await expect(page.getByRole("status")).toContainText("Clicked 1 time")
})

test("the theme toggle persists the explicit choice", async ({ page }) => {
  await page.goto("/")
  const toggle = page.getByRole("button", { name: /switch to .* theme/i })

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await toggle.click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
})

for (const width of [375, 1440] as const) {
  test(`fits the ${width}px viewport without horizontal overflow`, async ({ page }) => {
    const errors = collectErrors(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Try the interaction" }),
    ).toBeVisible()

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflows).toBe(false)
    expect(errors).toEqual([])
  })
}
