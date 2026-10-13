import type { Page } from "playwright";

export function flowLocators(page: Page) {
  return {
    // The Flow prompt is a contenteditable div (role=textbox), placeholder
    // "What do you want to create?" — not a labeled <textarea>.
    promptBox: page.locator('[role="textbox"][contenteditable="true"], .ProseMirror[contenteditable="true"]'),
    // Signed-in Flow dashboard/landing (projects view). Proves an authenticated session
    // for `doctor`; the prompt box only exists once a project is open.
    dashboardMarker: page.getByRole("button", { name: /new project|dự án mới/i }).or(
      page.locator("button").filter({ hasText: /new project|dự án mới/i })
    ),
    newProjectButton: page.getByRole("button", { name: /new project|dự án mới/i }).or(
      page.locator("button").filter({ hasText: /new project|dự án mới/i })
    ),
    // Submit button: "Create" carrying the arrow_forward icon (disabled until the prompt
    // has text). The sibling "add_2 Create" button is a different control.
    submitButton: page.locator('button[aria-label="Start generation"], button[aria-label="Bắt đầu tạo"], button.generate-icon-button, button[type="submit"]:has-text("arrow_forward")').or(
      page.locator("button").filter({ hasText: /create|tạo/i }).filter({ hasText: /arrow_forward/ })
    ).or(
      page.locator("button").filter({ hasText: /arrow_forward/ })
    ),
    // The model/settings pill (e.g. "🍌 Nano Banana 2 / crop_16_9 / x2") opens the popover
    // with Image/Video mode, aspect ratio, output count and model.
    settingsButton: page.locator("button.settings-trigger-button").or(
      page.locator("button").filter({ hasText: /crop_(16_9|9_16|square|portrait|landscape)/ })
    ),
    rateLimitMarker: page.getByText(/unusual activity|trying again too|rate limit|hoạt động bất thường|thử lại quá nhiều/i),
    creditMarker: page.getByText(/run out of credits|insufficient credits|no credits left|hết tín dụng|không đủ tín dụng/i),
    blockedMarker: page.getByText(/can.?t help with|violates|content policy|không thể hỗ trợ|vi phạm/i),
    failedMarker: page.getByText(/generation failed|couldn.?t generate|something went wrong|tạo không thành công|đã xảy ra lỗi/i),
    // Flow Agent asks "Would you like me to kick off this N video generation, costing X credits?"
    // and blocks until Approve / Always approve / Reject is chosen. Only the live prompt matches:
    // an already-answered one is rendered read-only with aria-disabled="true".
    alwaysApproveOption: page.locator('flow-permission-message [role="radio"][aria-label="Always approve"]:not([aria-disabled="true"]), flow-permission-message [role="radio"][aria-label*="luôn phê duyệt" i]:not([aria-disabled="true"])'),
    manualActionMarker: page.getByText(/verify your identity|sign in to continue|consent required|xác minh danh tính|đăng nhập để tiếp tục/i),
    characterPrompt: page.locator('[role="textbox"][contenteditable="true"]'),
    characterCreateButton: page.locator("button").filter({ hasText: /arrow_forward/ }).filter({ hasText: /create/i }),
    characterUploadButton: page.locator("button").filter({ hasText: /^upload/i }),
    characterAddFromProject: page.locator("button").filter({ hasText: /add from project/i })
  };
}
