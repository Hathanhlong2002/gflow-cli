import { describe, expect, it } from "vitest";
import { FlowAccount } from "../src/web/flow-account.js";

describe("Flow account login", () => {
  it("keeps the login window open during background status checks", async () => {
    let checks = 0;
    const account = new FlowAccount({
      isBusy: () => false,
      openLogin: async () => undefined,
      check: async () => { checks += 1; return { ready: true, message: "ready" }; }
    });

    await expect(account.login()).resolves.toMatchObject({ ready: false, loginPending: true });
    await expect(account.check()).resolves.toMatchObject({ ready: false, loginPending: true });
    expect(checks).toBe(0);
    await expect(account.check(true)).resolves.toMatchObject({ ready: true });
    expect(account.loginPending).toBe(false);
    expect(checks).toBe(1);
  });

  it("does not reopen Chrome for simultaneous login clicks", async () => {
    let opens = 0;
    let finish!: () => void;
    const opened = new Promise<void>((resolve) => { finish = resolve; });
    const account = new FlowAccount({
      isBusy: () => false,
      openLogin: async () => { opens += 1; await opened; },
      check: async () => ({ ready: true, message: "ready" })
    });
    const first = account.login();
    const second = account.login();
    finish();
    await Promise.all([first, second]);
    expect(opens).toBe(1);
  });

  it("waits for an existing doctor process before opening the login window", async () => {
    let finish!: () => void;
    const checked = new Promise<void>((resolve) => { finish = resolve; });
    const order: string[] = [];
    const account = new FlowAccount({
      isBusy: () => false,
      openLogin: async () => { order.push("login"); },
      check: async () => { await checked; order.push("doctor"); return { ready: false, message: "sign in" }; }
    });
    const checking = account.check();
    const opening = account.login();
    expect(order).toEqual([]);
    finish();
    await Promise.all([checking, opening]);
    expect(order).toEqual(["doctor", "login"]);
  });

  it("refuses to close the generation browser while a video is running", async () => {
    let opened = false;
    const account = new FlowAccount({
      isBusy: () => true,
      openLogin: async () => { opened = true; },
      check: async () => ({ ready: true, message: "ready" })
    });
    await expect(account.login()).rejects.toMatchObject({ code: "FLOW_BUSY", status: 409 });
    expect(opened).toBe(false);
  });

  it("allows retry after Chrome cannot open without exposing internal error details", async () => {
    let opens = 0;
    const account = new FlowAccount({
      isBusy: () => false,
      openLogin: async () => { if (opens++ === 0) throw new Error("sensitive launch detail"); },
      check: async () => ({ ready: true, message: "ready" })
    });
    const error = await account.login().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "FLOW_LOGIN_FAILED", status: 502 });
    expect(String(error)).not.toContain("sensitive launch detail");
    expect(account.loginPending).toBe(false);
    await expect(account.login()).resolves.toMatchObject({ loginPending: true });
  });
});
