import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://127.0.0.1:4173";

async function serveUI(page: Page, loginFails = false): Promise<{ doctors: number; logins: number; checks: number }> {
  const calls = { doctors: 0, logins: 0, checks: 0 };
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path === "/app.js") {
      await route.fulfill({
        contentType: path === "/" ? "text/html" : "text/javascript",
        body: await readFile(resolve("public", path === "/" ? "index.html" : "app.js"), "utf8")
      });
      return;
    }
    let body: unknown = {};
    let status = 200;
    if (path === "/api/doctor") {
      calls.doctors += 1;
      body = { ready: false, message: "Chưa đăng nhập Google Flow." };
    } else if (path === "/api/flow/login") {
      calls.logins += 1;
      status = loginFails ? 502 : 200;
      body = loginFails
        ? { error: "Không mở được Chrome. Hãy thử lại." }
        : { ready: false, loginPending: true, message: "Đăng nhập trong Chrome rồi quay lại kiểm tra." };
    } else if (path === "/api/flow/check") {
      calls.checks += 1;
      body = { ready: true, message: "Flow browser session looks ready." };
    } else if (path === "/api/runs") {
      body = { runs: [] };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return calls;
}

describe("Google Flow login UI", () => {
  it("opens login and waits for explicit verification before reporting connected", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const calls = await serveUI(page);
      await page.goto(ORIGIN, { waitUntil: "networkidle" });
      const login = page.getByRole("button", { name: "Đăng nhập Google Flow" });
      await login.click();
      await page.waitForFunction(() => document.getElementById("flowStatus")?.textContent === "Đang chờ bạn đăng nhập Google");
      expect(calls).toEqual({ doctors: 1, logins: 1, checks: 0 });
      await page.screenshot({ path: "/tmp/flow-factory-google-login.png", fullPage: true });
      await page.getByRole("button", { name: "Đã đăng nhập — Kiểm tra lại" }).click();
      await page.waitForFunction(() => document.getElementById("flowStatus")?.textContent === "Đã kết nối Google Flow");
      expect(calls.checks).toBe(1);
      expect(await page.locator("#doctorBanner").isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("shows login failures and keeps the controls usable on mobile", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await serveUI(page, true);
      await page.goto(ORIGIN, { waitUntil: "networkidle" });
      const login = page.getByRole("button", { name: "Đăng nhập Google Flow" });
      await login.click();
      await page.waitForFunction(() => document.getElementById("doctorBanner")?.textContent === "Không mở được Chrome. Hãy thử lại.");
      expect(await login.isEnabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Kiểm tra lại", exact: true }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: "/tmp/flow-factory-google-login-mobile.png", fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
