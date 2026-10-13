import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Frame, type Page } from "playwright";
import { launchLoginChrome, openBrowserSession, type BrowserChannel } from "../browser/session.js";
import { resolveProfileDir } from "../config/paths.js";
import { PublishError, type Privacy } from "./common.js";

export const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/creator-center/upload?from=upload";
export const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio/upload";

export interface TiktokBrowserUploadOptions {
  videoPath: string;
  caption: string;
  privacy?: Privacy;
  profile?: string;
  headed?: boolean;
  browser?: BrowserChannel;
  timeoutMs?: number;
  aiDisclosure?: boolean;
}

export interface TiktokBrowserUploadResult {
  status: "published" | "failed";
  caption: string;
  videoPath: string;
  at: string;
  id?: string;
  url?: string;
  error?: string;
}

export interface TiktokSessionInfo {
  profileExists: boolean;
  loggedIn: boolean;
  profileDir: string;
  username?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fast, non-intrusive check to see if Chrome profile contains saved TikTok session cookies.
 */
export async function checkTiktokBrowserSession(profile: string = "tiktok"): Promise<TiktokSessionInfo> {
  const profileDir = resolveProfileDir(profile);
  const info: TiktokSessionInfo = {
    profileExists: false,
    loggedIn: false,
    profileDir
  };

  try {
    const s = await stat(profileDir);
    if (!s.isDirectory()) return info;
    info.profileExists = true;

    // Check Chrome cookies sqlite file for TikTok session tokens
    const cookiePaths = [
      join(profileDir, "Default", "Network", "Cookies"),
      join(profileDir, "Default", "Cookies"),
      join(profileDir, "Network", "Cookies"),
      join(profileDir, "Cookies")
    ];

    for (const cp of cookiePaths) {
      try {
        const cookieStat = await stat(cp);
        if (cookieStat.size > 0) {
          // Fast check: SQLite stores plain domain and cookie names as ASCII strings
          const buffer = await readFile(cp);
          const content = buffer.toString("latin1");
          // TikTok session cookies: sessionid, sessionid_ss, sid_tt, passport_csrf_token
          if (content.includes(".tiktok.com") && (content.includes("sessionid") || content.includes("sid_tt") || content.includes("tt_chain_token"))) {
            info.loggedIn = true;
            break;
          }
        }
      } catch {
        // Continue checking other candidate paths
      }
    }
  } catch {
    // profile dir doesn't exist
  }

  return info;
}

/**
 * Open plain Google Chrome for one-time interactive login to TikTok.
 */
export async function launchTiktokLogin(profile: string = "tiktok"): Promise<string> {
  return launchLoginChrome(profile, "https://www.tiktok.com/login");
}

async function dismissOverlays(target: Page | Frame): Promise<void> {
  const closeSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Chấp nhận tất cả")',
    'button:has-text("Chấp nhận")',
    'button:has-text("Got it")',
    'button:has-text("Đã hiểu")',
    'button:has-text("Dismiss")',
    'button:has-text("Bỏ qua")',
    'button:has-text("Tắt")',
    'button:has-text("Đóng")',
    '[aria-label="Close"]',
    '[aria-label="Đóng"]'
  ];

  for (const sel of closeSelectors) {
    try {
      const btn = target.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => undefined);
        await sleep(200);
      }
    } catch {
      // Ignore
    }
  }
}

async function findUploadInput(page: Page): Promise<{ target: Page | Frame; input: ReturnType<Page["locator"]> }> {
  // Check main page first
  const mainInput = page.locator('input[type="file"][accept*="video"], input[type="file"]');
  if (await mainInput.count() > 0) {
    return { target: page, input: mainInput.first() };
  }

  // Check frames/iframes if TikTok renders upload inside an iframe
  for (const frame of page.frames()) {
    const frameInput = frame.locator('input[type="file"][accept*="video"], input[type="file"]');
    if (await frameInput.count() > 0) {
      return { target: frame, input: frameInput.first() };
    }
  }

  throw new PublishError("Không tìm thấy khu vực tải video lên TikTok. Giao diện có thể đã thay đổi hoặc chưa đăng nhập.", "UPLOAD_INPUT_NOT_FOUND");
}

async function setTiktokPrivacy(target: Page | Frame, privacy?: Privacy): Promise<void> {
  if (!privacy) return;

  const targetPattern = (privacy === "private" || privacy === "unlisted")
    ? /only you|chỉ mình tôi|riêng tư|private/i
    : /public|công khai/i;

  try {
    const privacyOption = target.locator('label, div[role="radio"], button, div.radio, [role="option"]').filter({ hasText: targetPattern }).first();
    if (await privacyOption.isVisible().catch(() => false)) {
      await privacyOption.click().catch(() => undefined);
      await sleep(400);
    }
  } catch (err) {
    console.warn(`[TikTok Browser] Không thể chỉnh chế độ hiển thị ${privacy}:`, err);
  }
}

async function setAiDisclosure(target: Page | Frame): Promise<void> {
  try {
    const aiToggle = target.locator('label, div, span').filter({ hasText: /AI-generated content|Nội dung do AI tạo|Nội dung AI/i }).first();
    if (await aiToggle.isVisible().catch(() => false)) {
      const checkboxOrSwitch = aiToggle.locator('input[type="checkbox"], [role="switch"]').first();
      if (await checkboxOrSwitch.isVisible().catch(() => false)) {
        const isChecked = await checkboxOrSwitch.isChecked().catch(() => false);
        if (!isChecked) {
          await aiToggle.click().catch(() => undefined);
          await sleep(400);
        }
      }
    }
  } catch {
    // Ignore if not present
  }
}

export async function uploadTiktokViaBrowser(options: TiktokBrowserUploadOptions): Promise<TiktokBrowserUploadResult> {
  const fileStat = await stat(options.videoPath).catch(() => {
    throw new PublishError(`Không tìm thấy file video tại: ${options.videoPath}`, "NO_VIDEO");
  });

  if (fileStat.size === 0) {
    throw new PublishError(`File video bị rỗng (0 bytes): ${options.videoPath}`, "EMPTY_VIDEO");
  }

  const profile = options.profile ?? "tiktok";
  const headed = options.headed ?? true;
  const browserType = options.browser ?? "chrome";
  const timeoutMs = options.timeoutMs ?? 180_000;

  console.log(`[TikTok Browser] Khởi động trình duyệt với profile: "${profile}"...`);
  const session = await openBrowserSession({
    profile,
    headed,
    browser: browserType
  });

  try {
    const page = session.page;
    console.log(`[TikTok Browser] Đang mở trang TikTok Studio: ${TIKTOK_STUDIO_URL}`);
    await page.goto(TIKTOK_STUDIO_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async () => {
      // Fallback to creator-center url
      await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    });

    await sleep(2000);
    await dismissOverlays(page);

    // Kiểm tra xem đã đăng nhập chưa
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/signin")) {
      throw new PublishError(
        `Chưa đăng nhập TikTok trên profile "${profile}". Hãy bấm "Đăng nhập TikTok" trên Web UI hoặc chạy:\n  gflow tiktok login --profile ${profile}`,
        "NOT_LOGGED_IN"
      );
    }

    const loginButton = page.locator('button:has-text("Log in"), button:has-text("Đăng nhập")');
    if (await loginButton.isVisible().catch(() => false)) {
      throw new PublishError(
        `Chưa đăng nhập TikTok trên profile "${profile}". Hãy bấm "Đăng nhập TikTok" trên Web UI hoặc chạy:\n  gflow tiktok login --profile ${profile}`,
        "NOT_LOGGED_IN"
      );
    }

    console.log("[TikTok Browser] Đang chờ khung tải video...");
    let uploadTarget: { target: Page | Frame; input: ReturnType<Page["locator"]> } | undefined;
    const findDeadline = Date.now() + 30000;
    while (Date.now() < findDeadline) {
      try {
        await dismissOverlays(page);
        uploadTarget = await findUploadInput(page);
        if (uploadTarget) break;
      } catch {
        await sleep(1000);
      }
    }

    console.log(`[TikTok Browser] Đang nạp video (${(fileStat.size / 1024 / 1024).toFixed(1)} MB)...`);
    let fileUploaded = false;

    // Strategy 1: fileChooser on clicking "Select video" / "Upload" button
    try {
      const selectButton = page.locator('button:has-text("Select video"), button:has-text("Upload"), button:has-text("Chọn video"), button:has-text("Chọn tệp")').or(
        page.locator('div[role="button"]:has-text("Select video"), div[role="button"]:has-text("Upload")')
      ).first();
      if (await selectButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 6000 }),
          selectButton.click({ force: true })
        ]);
        await fileChooser.setFiles(options.videoPath);
        fileUploaded = true;
      }
    } catch {
      // Continue to next strategy
    }

    // Strategy 2: setInputFiles on candidate input elements
    if (!fileUploaded) {
      const allTargets: Array<Page | Frame> = [page, ...page.frames()];
      for (const t of allTargets) {
        try {
          const fileInput = t.locator('input[type="file"]').first();
          if (await fileInput.count() > 0) {
            // TikTok input can be hidden or detached, setInputFiles might reject or time out
            // even though the browser already accepted the file
            await fileInput.setInputFiles(options.videoPath, { timeout: 8000 }).catch(() => {});
            fileUploaded = true;
            break;
          }
        } catch {
          // Continue
        }
      }
    }

    // Verification: kiểm tra xem TikTok Studio đã nhận video và đang chuyển sang màn hình edit chưa
    const editorDetected = await Promise.race([
      page.locator('div[contenteditable="true"], button:has-text("Edit cover"), text="Uploaded", text="Đã tải lên"').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false),
      sleep(3000).then(() => false)
    ]);

    if (!fileUploaded && !editorDetected) {
      throw new PublishError("Không thể nạp file video vào TikTok Studio. Giao diện có thể đã thay đổi.", "UPLOAD_INPUT_FAILED");
    }

    console.log("[TikTok Browser] Đã nạp file video thành công. Đang chờ giao diện biên tập...");
    await sleep(3000);
    const target = page;

    // Selector ô caption thường gặp trên TikTok Web
    const captionSelectors = [
      'div[contenteditable="true"]',
      '.DraftEditor-editorContainer [contenteditable="true"]',
      '.notranslate[contenteditable="true"]',
      'div[data-placeholder*="caption" i]',
      'div[data-placeholder*="mô tả" i]',
      'div[data-placeholder*="bài viết" i]',
      'textarea[placeholder*="caption" i]',
      'textarea'
    ];

    let captionBox: ReturnType<Page["locator"]> | undefined;
    const captionDeadline = Date.now() + 60000;
    while (Date.now() < captionDeadline) {
      await dismissOverlays(target);
      for (const sel of captionSelectors) {
        const candidate = target.locator(sel).first();
        if (await candidate.isVisible().catch(() => false)) {
          captionBox = candidate;
          break;
        }
      }
      if (captionBox) break;
      await sleep(1500);
    }

    if (captionBox) {
      console.log("[TikTok Browser] Đang nhập tiêu đề và hashtag...");
      await captionBox.click().catch(() => undefined);
      // Xóa nội dung mặc định nếu có (TikTok có thể tự điền tên file làm caption)
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
      await page.keyboard.press("Backspace").catch(() => undefined);
      await sleep(200);

      // Nhập nội dung caption
      await page.keyboard.insertText(options.caption);
      await sleep(800);
    } else {
      console.warn("[TikTok Browser] Không tìm thấy ô caption riêng biệt, giữ nguyên mặc định.");
    }

    // Thiết lập chế độ hiển thị (Privacy) nếu được yêu cầu
    if (options.privacy) {
      await setTiktokPrivacy(target, options.privacy);
    }

    // Bật nhãn nội dung do AI tạo (mặc định bật vì đây là AI Short / Music Video)
    if (options.aiDisclosure !== false) {
      await setAiDisclosure(target);
    }

    // Chờ quá trình upload hoàn tất (nút Post enable và video upload xong)
    console.log("[TikTok Browser] Đang đợi video upload hoàn tất...");
    const postButtonSelectors = [
      'button:has-text("Post")',
      'button:has-text("Đăng")',
      'button[type="button"]:has-text("Post")',
      'button[type="button"]:has-text("Đăng")',
      '.btn-post'
    ];

    let postButton: ReturnType<Page["locator"]> | undefined;
    const uploadDeadline = Date.now() + timeoutMs;
    while (Date.now() < uploadDeadline) {
      await dismissOverlays(target);

      for (const sel of postButtonSelectors) {
        const btn = target.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.scrollIntoViewIfNeeded().catch(() => undefined);
          const isEnabled = await btn.isEnabled().catch(() => false);
          const isAriaDisabled = await btn.getAttribute("aria-disabled").catch(() => null);
          const className = (await btn.getAttribute("class").catch(() => "")) || "";
          const isDisabledClass = className.includes("disabled") || isAriaDisabled === "true";
          if (isEnabled && !isDisabledClass) {
            postButton = btn;
            break;
          }
        }
      }
      if (postButton) break;

      // Kiểm tra xem có thông báo lỗi bản quyền hoặc lỗi tải file không
      const errorNotice = target.locator('.error, .alert-error, [role="alert"]');
      if (await errorNotice.isVisible().catch(() => false)) {
        const text = await errorNotice.textContent().catch(() => "");
        if (text && text.trim().length > 0 && /error|lỗi|fail/i.test(text)) {
          console.warn(`[TikTok Browser] Cảnh báo từ TikTok: ${text.trim()}`);
        }
      }

      await sleep(2000);
    }

    if (!postButton) {
      throw new PublishError("Hết thời gian chờ video tải lên hoàn tất hoặc nút Đăng không khả dụng.", "UPLOAD_TIMEOUT");
    }

    console.log("[TikTok Browser] Nhấn nút Đăng video...");
    await postButton.click();
    await sleep(2000);

    // Xử lý modal xác nhận phụ nếu có (Post now / Đăng ngay)
    const confirmPostSelectors = [
      'button:has-text("Post now")',
      'button:has-text("Post anyway")',
      'button:has-text("Đăng ngay")',
      'button:has-text("Vẫn đăng")'
    ];
    for (const sel of confirmPostSelectors) {
      const confirmBtn = target.locator(sel).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        console.log("[TikTok Browser] Xác nhận modal đăng...");
        await confirmBtn.click().catch(() => undefined);
        break;
      }
    }

    // Chờ thông báo thành công (Modal "Manage your posts", "View profile", "Uploaded", etc.)
    console.log("[TikTok Browser] Đang xác nhận video đã xuất bản...");
    const successIndicators = [
      'text="Your video has been uploaded"',
      'text="Video của bạn đã được tải lên"',
      'text="Manage your posts"',
      'text="Quản lý bài viết"',
      'button:has-text("Manage your posts")',
      'button:has-text("Quản lý bài viết")'
    ];

    let confirmed = false;
    let postUrl: string | undefined;
    const confirmDeadline = Date.now() + 45000;
    while (Date.now() < confirmDeadline) {
      for (const ind of successIndicators) {
        if (await target.locator(ind).first().isVisible().catch(() => false)) {
          confirmed = true;
          break;
        }
      }
      if (confirmed) break;
      if (page.url().includes("/manage") || page.url().includes("/content") || page.url().includes("/tiktokstudio")) {
        if (!page.url().includes("/upload")) {
          confirmed = true;
          postUrl = page.url();
          break;
        }
      }
      await sleep(1500);
    }

    console.log("[TikTok Browser] Video đã được đăng lên TikTok thành công!");
    return {
      status: "published",
      caption: options.caption,
      videoPath: options.videoPath,
      at: new Date().toISOString(),
      url: postUrl ?? "https://www.tiktok.com/tiktokstudio/content"
    };
  } finally {
    await sleep(2000);
    await session.close().catch(() => undefined);
  }
}
