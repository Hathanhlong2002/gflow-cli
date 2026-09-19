const topicInput = document.getElementById("topic");
const durationInput = document.getElementById("duration");
const submitBtn = document.getElementById("submitBtn");
const progressBox = document.getElementById("progress");
const stageLine = document.getElementById("stageLine");
const stageText = document.getElementById("stageText");
const logBox = document.getElementById("log");
const videoWrap = document.getElementById("videoWrap");
const video = document.getElementById("video");
const downloadLink = document.getElementById("downloadLink");
const retryBtn = document.getElementById("retryBtn");
const doctorBanner = document.getElementById("doctorBanner");
const pastList = document.getElementById("pastList");

let currentSource = null;
let currentProjectId = null;

async function checkDoctor() {
  try {
    const res = await fetch("/api/doctor");
    const data = await res.json();
    if (!data.ready) {
      doctorBanner.classList.add("warn");
      doctorBanner.textContent =
        "Chưa đăng nhập Google Flow trong Chrome tự động hoá. Mở terminal, chạy: npx tsx src/index.ts auth login rồi đăng nhập, sau đó quay lại đây.";
    } else {
      doctorBanner.classList.remove("warn");
      doctorBanner.textContent = "";
    }
  } catch {
    // Server chưa sẵn sàng trả doctor — bỏ qua, không chặn UI.
  }
}

function renderStage(status, stageLabel, message) {
  progressBox.classList.add("visible");
  stageLine.classList.remove("done", "error");
  if (status === "ready") {
    stageLine.classList.add("done");
    stageText.textContent = "Hoàn tất!";
  } else if (status === "failed") {
    stageLine.classList.add("error");
    stageText.textContent = `Thất bại${stageLabel ? ": " + stageLabel : ""}${message ? " — " + message : ""}`;
  } else {
    stageText.textContent = stageLabel ?? "Đang xử lý…";
  }
}

function appendLog(lines) {
  if (!lines || lines.length === 0) return;
  logBox.textContent = lines.join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}

function startStream(id) {
  if (currentSource) currentSource.close();
  const source = new EventSource(`/api/runs/${id}/stream`);
  currentSource = source;
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    renderStage(data.status, data.stageLabel, data.message);
    appendLog(data.log);
    if (data.status === "ready") {
      showVideo(id);
      submitBtn.disabled = false;
      source.close();
      loadPastRuns();
    } else if (data.status === "failed") {
      retryBtn.style.display = "inline-block";
      submitBtn.disabled = false;
      source.close();
      loadPastRuns();
    }
  };
  source.onerror = () => {
    // Kết nối SSE đóng khi tiến trình hoàn tất — không cần báo lỗi cho người dùng.
  };
}

function showVideo(id) {
  currentProjectId = id;
  loadPublishPanel(id);
  videoWrap.classList.add("visible");
  video.src = `/api/runs/${id}/video`;
  downloadLink.href = `/api/runs/${id}/video`;
  retryBtn.style.display = "none";
}

async function submitTopic(topic, duration) {
  submitBtn.disabled = true;
  videoWrap.classList.remove("visible");
  progressBox.classList.add("visible");
  logBox.textContent = "";
  stageLine.classList.remove("done", "error");
  stageText.textContent = "Đang bắt đầu…";

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, duration })
  });
  const data = await res.json();
  if (!res.ok) {
    stageLine.classList.add("error");
    stageText.textContent = data.error ?? "Lỗi không xác định";
    submitBtn.disabled = false;
    return;
  }
  if (data.alreadyDone) {
    renderStage("ready");
    showVideo(data.id);
    submitBtn.disabled = false;
    return;
  }
  startStream(data.id);
}

submitBtn.addEventListener("click", () => {
  const topic = topicInput.value.trim();
  const duration = Number(durationInput.value) || 75;
  if (topic.length < 3) {
    alert("Nhập chủ đề ít nhất 3 ký tự.");
    return;
  }
  submitTopic(topic, duration);
});

topicInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitBtn.click();
});

retryBtn.addEventListener("click", () => {
  retryBtn.style.display = "none";
  // Gửi lại cùng chủ đề/độ dài; server phát hiện project đã tồn tại và tự resume từ checkpoint.
  submitTopic(topicInput.value.trim(), Number(durationInput.value) || 75);
});

function stagePill(stage) {
  if (stage === "READY") return '<span class="pill ready">Xong</span>';
  if (stage === "FAILED") return '<span class="pill failed">Lỗi</span>';
  return `<span class="pill">${stage}</span>`;
}

const PRIVACY_LABELS = { private: "Riêng tư", unlisted: "Không công khai", public: "Công khai" };
const PLATFORM_NAMES = { youtube: "YouTube", tiktok: "TikTok" };
let pastRuns = [];
let pastFilter = "all";

function formatWhen(iso) {
  return iso ? new Date(iso).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

// Mỗi video luôn hiện đủ cả hai nền tảng: đã đăng / chưa đăng / lỗi / đang đăng.
function slotHtml(slot) {
  const name = PLATFORM_NAMES[slot.platform] || slot.platform;
  if (slot.state === "publishing") return `<span class="pill">⏳ ${name}: đang đăng…</span>`;
  if (slot.state === "none") return `<span class="pill none">${name}: chưa đăng</span>`;
  if (slot.state === "failed") {
    return `<span class="pill failed" title="${escapeHtml(slot.error || "")}">✗ ${name}: lỗi lúc ${escapeHtml(formatWhen(slot.at))}</span>`;
  }
  const privacy = PRIVACY_LABELS[slot.privacy] || slot.privacy || "";
  const forced = slot.requestedPrivacy && slot.requestedPrivacy !== slot.privacy ? ` (bạn chọn ${PRIVACY_LABELS[slot.requestedPrivacy] || slot.requestedPrivacy})` : "";
  const label = `✓ ${name}: đã đăng · ${privacy}${forced} · ${formatWhen(slot.at)}`;
  const title = slot.videoChanged ? "Video đã được render lại sau khi đăng, bài trên " + name + " là bản cũ" : "";
  const warn = slot.videoChanged ? ' <span class="pill warn" title="Video đã render lại sau lần đăng này">bản cũ</span>' : "";
  // Chỉ cho phép liên kết https do server tạo ra.
  const body = typeof slot.url === "string" && slot.url.startsWith("https://")
    ? `<a class="pill ready" href="${escapeHtml(slot.url)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`
    : `<span class="pill ready" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  return body + warn;
}

function slotOf(run, platform) {
  return (run.slots || []).find((slot) => slot.platform === platform) || { platform, state: "none" };
}

const PAST_FILTERS = {
  all: () => true,
  "no-youtube": (run) => run.hasVideo && slotOf(run, "youtube").state !== "published",
  "no-tiktok": (run) => run.hasVideo && slotOf(run, "tiktok").state !== "published",
  done: (run) => run.hasVideo && slotOf(run, "youtube").state === "published" && slotOf(run, "tiktok").state === "published"
};

function renderPastRuns() {
  const withVideo = pastRuns.filter((run) => run.hasVideo);
  const count = (platform) => withVideo.filter((run) => slotOf(run, platform).state === "published").length;
  document.getElementById("pastSummary").textContent =
    `${withVideo.length} video · YouTube ${count("youtube")}/${withVideo.length} đã đăng · TikTok ${count("tiktok")}/${withVideo.length} đã đăng`;

  const shown = pastRuns.filter(PAST_FILTERS[pastFilter] || PAST_FILTERS.all);
  if (shown.length === 0) {
    pastList.innerHTML = '<p class="note">Không có video nào khớp bộ lọc.</p>';
    return;
  }
  pastList.innerHTML = shown
    .map((run) => {
      const actions = run.hasVideo
        ? `<span><a class="link" href="/api/runs/${run.id}/video" target="_blank">Xem video</a> · <button class="link-btn" data-publish="${escapeHtml(run.id)}">Đăng bài</button></span>`
        : "";
      const slots = run.hasVideo ? (run.slots || []).map(slotHtml).join(" ") : "";
      return `<div class="past-item"><div><div class="topic">${escapeHtml(run.topic)}</div><div class="stage">${stagePill(run.stage)} ${slots}</div></div>${actions}</div>`;
    })
    .join("");
}

async function loadPastRuns() {
  const res = await fetch("/api/runs");
  const data = await res.json();
  pastRuns = data.runs || [];
  if (pastRuns.length === 0) {
    pastList.innerHTML = '<p class="note">Chưa có video nào.</p>';
    document.getElementById("pastSummary").textContent = "";
    return;
  }
  renderPastRuns();
}

document.getElementById("pastFilter").addEventListener("change", (event) => {
  pastFilter = event.target.value;
  renderPastRuns();
});

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

checkDoctor();
loadPastRuns();


// ---------- Đăng bài lên YouTube / TikTok ----------

const publishCard = document.getElementById("publishCard");
const accountsBox = document.getElementById("accounts");
const pubTitle = document.getElementById("pubTitle");
const pubDesc = document.getElementById("pubDesc");
const pubTags = document.getElementById("pubTags");
const pubPrivacy = document.getElementById("pubPrivacy");
const pubKids = document.getElementById("pubKids");
const publishBtn = document.getElementById("publishBtn");
const publishResult = document.getElementById("publishResult");

const PLATFORM_LABELS = { youtube: "YouTube", tiktok: "TikTok" };
const SETUP_ENV = {
  youtube: "YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET (OAuth client loại “Desktop app” trong Google Cloud, bật YouTube Data API v3)",
  tiktok: "TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET (app trên TikTok for Developers, bật Login Kit + Content Posting API, platform Desktop)"
};
let publishStatus = null;
let publishedRecords = [];

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json" },
    body: options && options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function publishedFor(platform) {
  return publishedRecords.findLast((record) => record.platform === platform && record.status === "published");
}

function renderAccounts() {
  accountsBox.innerHTML = "";
  for (const platform of ["youtube", "tiktok"]) {
    const info = publishStatus[platform];
    const done = publishedFor(platform);
    const row = document.createElement("div");
    row.className = "acct";

    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.platform = platform;
    box.checked = info.connected && !done;
    // Đã đăng rồi thì khoá ô chọn để không đăng trùng, trừ khi bật "Đăng lại".
    box.disabled = !info.connected || (Boolean(done) && !document.getElementById("pubRepost").checked);
    label.append(box, document.createTextNode(PLATFORM_LABELS[platform]));

    const state = document.createElement("span");
    state.className = "state" + (info.connected ? " ok" : "");
    state.textContent = done ? "Đã đăng" : info.connected ? "Đã kết nối" : info.configured ? "Chưa kết nối" : "Chưa cấu hình";

    const spacer = document.createElement("span");
    spacer.className = "spacer";
    row.append(label, state, spacer);

    if (done && done.url) {
      const link = document.createElement("a");
      link.className = "link";
      link.href = done.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Mở bài đăng";
      row.append(link);
    }

    const action = document.createElement("button");
    action.className = "secondary";
    action.textContent = info.connected ? "Ngắt kết nối" : "Kết nối";
    action.disabled = !info.configured && !info.connected;
    action.addEventListener("click", () => (info.connected ? disconnect(platform) : connect(platform)));
    row.append(action);

    if (!info.configured && !info.connected) {
      const hint = document.createElement("div");
      hint.className = "setup-hint";
      hint.textContent = `Cần thêm vào file .env: ${SETUP_ENV[platform]}. Redirect URI cần đăng ký: ${publishStatus.redirectUris[platform]}`;
      row.append(hint);
    }
    accountsBox.append(row);
  }
}

async function refreshPublishStatus() {
  publishStatus = await api("/api/publish/status");
  renderAccounts();
}

async function connect(platform) {
  try {
    const { url } = await api("/api/publish/connect", { method: "POST", body: { platform } });
    window.open(url, "_blank", "noopener");
    // Chờ người dùng đăng nhập xong ở tab mới rồi tự cập nhật trạng thái.
    for (let i = 0; i < 90; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await refreshPublishStatus();
      if (publishStatus[platform].connected) return;
    }
  } catch (error) {
    showPublishMessage(`${PLATFORM_LABELS[platform]}: ${error.message}`, false);
  }
}

async function disconnect(platform) {
  if (!confirm(`Ngắt kết nối ${PLATFORM_LABELS[platform]}? Tool sẽ xoá token đã lưu.`)) return;
  await api("/api/publish/disconnect", { method: "POST", body: { platform } });
  await refreshPublishStatus();
}

function showPublishMessage(text, ok) {
  const div = document.createElement("div");
  div.className = "result " + (ok ? "ok" : "fail");
  div.textContent = text;
  publishResult.append(div);
}

async function loadPublishPanel(id) {
  publishCard.classList.add("visible");
  publishResult.innerHTML = "";
  pubTitle.value = "";
  pubDesc.value = "";
  pubTags.value = "";
  pubTitle.placeholder = "Đang tự điền thông tin…";
  publishBtn.disabled = true;
  try {
    const [, meta] = await Promise.all([refreshPublishStatus(), api(`/api/publish/metadata?id=${encodeURIComponent(id)}`)]);
    if (currentProjectId !== id) return;
    publishedRecords = meta.history || [];
    renderAccounts();
    pubTitle.value = meta.metadata.title;
    pubDesc.value = meta.metadata.description;
    pubTags.value = meta.metadata.tags.join(", ");
    publishBtn.disabled = false;
  } catch (error) {
    showPublishMessage(error.message, false);
  } finally {
    pubTitle.placeholder = "";
  }
}

document.getElementById("pubRepost").addEventListener("change", renderAccounts);

publishBtn.addEventListener("click", async () => {
  const platforms = [...accountsBox.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.dataset.platform);
  if (platforms.length === 0) {
    alert("Chọn ít nhất một nền tảng đã kết nối.");
    return;
  }
  const privacy = pubPrivacy.value;
  if (privacy === "unlisted" && platforms.includes("tiktok")) {
    alert("TikTok không có chế độ “Không công khai”. Hãy chọn Riêng tư hoặc Công khai, hoặc bỏ chọn TikTok.");
    return;
  }
  const names = platforms.map((platform) => PLATFORM_LABELS[platform]).join(" và ");
  const privacyLabel = pubPrivacy.options[pubPrivacy.selectedIndex].text;
  const repost = document.getElementById("pubRepost").checked;
  const duplicates = platforms.filter((platform) => publishedFor(platform)).map((platform) => PLATFORM_LABELS[platform]);
  const warning = repost && duplicates.length > 0 ? `\n\nLƯU Ý: video này đã đăng trên ${duplicates.join(" và ")}. Việc này sẽ tạo thêm một bài thứ hai (trùng).` : "";
  if (!confirm(`Đăng video “${pubTitle.value}” lên ${names} ở chế độ ${privacyLabel}?${warning}`)) return;

  publishBtn.disabled = true;
  publishResult.innerHTML = "";
  showPublishMessage("Đang tải video lên, có thể mất vài phút…", true);
  try {
    const data = await api("/api/publish", {
      method: "POST",
      body: {
        id: currentProjectId,
        platforms,
        privacy,
        madeForKids: pubKids.checked,
        force: repost,
        metadata: {
          title: pubTitle.value,
          description: pubDesc.value,
          tags: pubTags.value.split(",").map((tag) => tag.trim()).filter(Boolean)
        }
      }
    });
    publishResult.innerHTML = "";
    for (const record of data.results) {
      const name = PLATFORM_LABELS[record.platform];
      showPublishMessage(
        record.status === "published" ? `${name}: đã đăng${record.url ? " — " + record.url : ""}` : `${name}: thất bại — ${record.error}`,
        record.status === "published"
      );
    }
    publishedRecords = await api(`/api/publish/history?id=${encodeURIComponent(currentProjectId)}`).then((r) => r.history).catch(() => publishedRecords);
    renderAccounts();
    loadPastRuns();
  } catch (error) {
    publishResult.innerHTML = "";
    showPublishMessage(error.message, false);
  } finally {
    publishBtn.disabled = false;
  }
});

pastList.addEventListener("click", (event) => {
  const id = event.target && event.target.dataset ? event.target.dataset.publish : undefined;
  if (!id) return;
  progressBox.classList.remove("visible");
  showVideo(id);
  window.scrollTo({ top: 0, behavior: "smooth" });
});
