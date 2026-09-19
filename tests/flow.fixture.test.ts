import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { FlowPage } from "../src/flow/page.js";

const FIXTURE = `file://${process.cwd()}/fixtures/flow/index.html`;
const projectFixture = (label: string) => `<!doctype html>
<html lang="en">
  <body>
    <main>
      <div data-project="${label}" class="ProseMirror" contenteditable="true"></div>
      <button id="create" aria-label="Start generation" disabled>arrow_forward</button>
      <section id="results"></section>
    </main>
    <script>
      const prompt = document.querySelector('.ProseMirror[contenteditable="true"]');
      const create = document.getElementById("create");
      prompt.addEventListener("input", () => { create.disabled = prompt.textContent.trim().length === 0; });
      create.addEventListener("click", () => {
        const img = document.createElement("img");
        img.src = "data:text/plain," + document.querySelector('[data-project]').dataset.project;
        img.style.width = "40px";
        img.style.height = "40px";
        img.addEventListener("click", () => {
          const overlay = document.createElement("div");
          overlay.setAttribute("role", "dialog");
          overlay.innerHTML = '<button type="button" aria-haspopup="menu" data-dl>download Download</button><div role="menu" hidden><div role="menuitem" data-q="original">1K Original size</div></div>';
          document.body.appendChild(overlay);
          const menu = overlay.querySelector("[role=menu]");
          overlay.querySelector("[data-dl]").addEventListener("click", () => { menu.hidden = false; });
          overlay.querySelector("[role=menuitem]").addEventListener("click", () => {
            const blob = new Blob([document.querySelector('[data-project]').dataset.project + ":original"], { type: "image/png" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "project.png";
            document.body.appendChild(a);
            a.click();
          });
        });
        document.getElementById("results").appendChild(img);
      });
    </script>
  </body>
</html>`;

const currentFlowVideoFixture = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <div class="ProseMirror" contenteditable="true"></div>
      <button id="create" aria-label="Start generation" disabled>arrow_forward</button>
      <section id="results"><img alt="Generated video thumbnail" src="data:image/png;base64,old"></section>
      <div role="dialog" hidden>
        <button id="download" aria-label="Download media">download</button>
        <div role="menu" hidden><div role="menuitem" id="original">Original size</div></div>
      </div>
    </main>
    <script>
      const prompt = document.querySelector('.ProseMirror[contenteditable="true"]');
      const create = document.getElementById("create");
      const dialog = document.querySelector('[role="dialog"]');
      const menu = document.querySelector('[role="menu"]');
      prompt.addEventListener("input", () => { create.disabled = prompt.textContent.trim().length === 0; });
      create.addEventListener("click", () => {
        create.removeAttribute("aria-label");
        create.textContent = "stop";
        window.setTimeout(() => {
          const thumbnail = document.createElement("img");
          thumbnail.alt = "Generated video thumbnail";
          thumbnail.src = "data:image/png;base64,iVBORw0KGgo=";
          thumbnail.addEventListener("click", () => { dialog.hidden = false; });
          document.getElementById("results").replaceChildren(thumbnail);
          create.setAttribute("aria-label", "Start generation");
          create.textContent = "arrow_forward";
        }, 100);
      });
      document.getElementById("download").addEventListener("click", () => { menu.hidden = false; });
      document.getElementById("original").addEventListener("click", () => {
        const bytes = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);
        const blob = new Blob([bytes], { type: "video/mp4" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "flow-clip.mp4";
        document.body.appendChild(a);
        a.click();
      });
    </script>
  </body>
</html>`;

describe("FlowPage fixture", () => {
  it("types a prompt, submits, and downloads the generated result", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(FIXTURE);

      const flow = new FlowPage(page);
      const result = await flow.runJob({
        job: { id: "concept-image", type: "image", prompt: "A studio product still", outputs: 1, out: outDir, ingredients: [], character: [] },
        outDir
      });

      expect(result.jobId).toBe("concept-image");
      expect(result.artifacts).toHaveLength(1);
      const saved = result.artifacts[0]!.path;
      expect(saved).toContain("concept-image-001.png");
      // Downloaded through the viewer's Download menu (Original tier); the fixture encodes
      // the result identity in the bytes so we verify the right result reached disk.
      await expect(readFile(saved, "utf8")).resolves.toBe("fixture-gen-1:original");
    } finally {
      await context.close();
    }
  });

  it("fills a multiline prompt without pressing Enter and submitting early", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(FIXTURE);
      await page.evaluate(() => {
        (window as typeof window & { prematureSubmitSignals: number }).prematureSubmitSignals = 0;
        const prompt = document.querySelector('[role="textbox"][contenteditable="true"], .ProseMirror[contenteditable="true"]');
        for (const eventName of ["keydown", "beforeinput", "input"]) {
          prompt?.addEventListener(eventName, (event) => {
            const keyboardEvent = event as KeyboardEvent;
            const inputEvent = event as InputEvent;
            if (
              keyboardEvent.key === "Enter" || inputEvent.data === "\n" ||
              inputEvent.inputType === "insertParagraph" || inputEvent.inputType === "insertLineBreak"
            ) {
              (window as typeof window & { prematureSubmitSignals: number }).prematureSubmitSignals += 1;
            }
          });
        }
      });

      await new FlowPage(page).runJob({
        job: {
          id: "multiline-prompt",
          type: "image",
          prompt: "First visual line\nSecond motion line",
          outputs: 1,
          out: outDir,
          ingredients: [],
          character: []
        },
        outDir
      });

      await expect(page.evaluate(() => (window as typeof window & { prematureSubmitSignals: number }).prematureSubmitSignals)).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });

  it("detects fresh results per run instead of reusing earlier ones", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${FIXTURE}?delay=100`);

      const flow = new FlowPage(page);
      const first = await flow.runJob({
        job: { id: "first-image", type: "image", prompt: "First image", outputs: 1, out: outDir, ingredients: [], character: [] },
        outDir
      });
      const second = await flow.runJob({
        job: { id: "second-image", type: "image", prompt: "Second image", outputs: 1, out: outDir, ingredients: [], character: [] },
        outDir
      });

      expect(first.artifacts[0]?.path).toContain("first-image-001.png");
      expect(second.artifacts[0]?.path).toContain("second-image-001.png");
      await expect(readFile(first.artifacts[0]!.path, "utf8")).resolves.toBe("fixture-gen-1:original");
      await expect(readFile(second.artifacts[0]!.path, "utf8")).resolves.toBe("fixture-gen-2:original");
    } finally {
      await context.close();
    }
  });

  it("downloads a video through the viewer's menu-less Download button", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      // ?type=video makes the fixture render a <video> result whose viewer has a plain
      // Download button (no tier menu), like real Flow — exercising the direct-download path.
      await page.goto(`${FIXTURE}?type=video`);

      const flow = new FlowPage(page);
      const result = await flow.runJob({
        job: { id: "clip", type: "video", prompt: "A short clip", outputs: 1, out: outDir, ingredients: [], character: [] },
        outDir
      });

      const saved = result.artifacts[0]!.path;
      expect(saved).toContain("clip-001.mp4");
      await expect(readFile(saved, "utf8")).resolves.toBe("fixture-gen-1:original");
    } finally {
      await context.close();
    }
  });

  it("detects and downloads a video from the current Flow editor", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setContent(currentFlowVideoFixture);

      const result = await new FlowPage(page).runJob({
        job: {
          id: "current-flow-clip",
          type: "video",
          prompt: "A small boat crossing calm ocean water",
          ratio: "9:16",
          duration: 8,
          outputs: 1,
          timeout: 3,
          out: outDir,
          ingredients: [],
          character: []
        },
        outDir
      });

      expect(result.artifacts).toHaveLength(1);
      const saved = result.artifacts[0]!.path;
      expect(saved).toContain("current-flow-clip-001.mp4");
      const bytes = await readFile(saved);
      expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
      expect(result.artifacts[0]!.metadataPath).toContain("current-flow-clip-001.json");
    } finally {
      await context.close();
    }
  });

  it("does not treat a returned Start button as completion without a video thumbnail", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setDefaultTimeout(500);
      await page.setContent(currentFlowVideoFixture.replace(
        'document.getElementById("results").replaceChildren(thumbnail);',
        'document.getElementById("results").replaceChildren();'
      ));

      await expect(new FlowPage(page).runJob({
        job: {
          id: "missing-current-flow-clip",
          type: "video",
          prompt: "A small boat crossing calm ocean water",
          ratio: "9:16",
          duration: 8,
          outputs: 1,
          timeout: 3,
          out: outDir,
          ingredients: [],
          character: []
        },
        outDir
      })).rejects.toThrow(/Timed out waiting for a video/i);
    } finally {
      await context.close();
    }
  });

  it("answers the live Flow Agent credit prompt with Always approve and ignores read-only ones", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });
    const staleAnsweredPrompt =
      '<flow-permission-message id="stale"><div role="radiogroup">' +
      '<div role="radio" aria-label="Always approve" aria-checked="false" aria-disabled="true" class="read-only">Always approve</div>' +
      "</div></flow-permission-message>";
    const livePromptScript = `
      window.__choice = null;
      window.__staleClicked = false;
      document.getElementById("stale").addEventListener("click", () => { window.__staleClicked = true; });
      create.addEventListener("click", () => {
        const live = document.createElement("flow-permission-message");
        live.innerHTML = '<p>Would you like me to kick off this 1 video generation, costing 15 credits?</p>' +
          '<div role="radiogroup">' +
          '<div role="radio" aria-label="Approve" aria-checked="false" tabindex="0">Approve</div>' +
          '<div role="radio" aria-label="Always approve" aria-checked="false" tabindex="0">Always approve</div>' +
          '<div role="radio" aria-label="Reject" aria-checked="false" tabindex="0">Reject</div></div>';
        document.body.appendChild(live);
        for (const option of live.querySelectorAll('[role="radio"]')) {
          option.addEventListener("click", () => {
            window.__choice = option.getAttribute("aria-label");
            live.remove();
            if (window.__choice === "Always approve") window.setTimeout(window.__finish, 300);
          });
        }
      });`;

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      // Generation only completes once the live prompt is answered, as in Flow Agent.
      await page.setContent(
        currentFlowVideoFixture
          .replace("window.setTimeout(() => {", "window.__finish = () => {")
          .replace("}, 100);", "};")
          .replace('<div role="dialog" hidden>', `${staleAnsweredPrompt}<div role="dialog" hidden>`)
          .replace("</script>", `${livePromptScript}</script>`)
      );

      const result = await new FlowPage(page).runJob({
        job: {
          id: "approval-clip",
          type: "video",
          prompt: "A small boat crossing calm ocean water",
          ratio: "9:16",
          duration: 8,
          outputs: 1,
          timeout: 10,
          out: outDir,
          ingredients: [],
          character: []
        },
        outDir
      });

      expect(result.artifacts).toHaveLength(1);
      expect(await page.evaluate(() => (window as unknown as { __choice: string }).__choice)).toBe("Always approve");
      expect(await page.evaluate(() => (window as unknown as { __staleClicked: boolean }).__staleClicked)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("navigates to the requested project before generating", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "gflow-profile-"));
    const outDir = await mkdtemp(join(tmpdir(), "gflow-output-"));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const targetProjectId = "00000000-0000-4000-8000-000000000000";
      await page.route("https://flow.google.com", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: `<a href="/project/${targetProjectId}"><span>Target Project</span></a>`
        });
      });
      await page.route(`https://flow.google.com/project/${targetProjectId}`, async (route) => {
        await route.fulfill({ contentType: "text/html", body: projectFixture("target") });
      });
      await page.route("https://flow.google.com/project/wrong", async (route) => {
        await route.fulfill({ contentType: "text/html", body: projectFixture("wrong") });
      });
      await page.goto("https://flow.google.com/project/wrong");

      const flow = new FlowPage(page);
      const result = await flow.runJob({
        job: {
          id: "project-image",
          type: "image",
          project: "Target Project",
          prompt: "Use the requested project",
          outputs: 1,
          out: outDir,
          ingredients: [],
          character: []
        },
        outDir
      });

      expect(result.flowUrl).toContain(`/project/${targetProjectId}`);
      await expect(readFile(result.artifacts[0]!.path, "utf8")).resolves.toBe("target:original");
    } finally {
      await context.close();
    }
  }, 30000);
});
