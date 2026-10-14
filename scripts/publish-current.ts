import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Publisher } from "../src/publish/publisher.js";
import { TokenStore } from "../src/publish/common.js";

function parseEnv(): Record<string, string> {
  const content = readFileSync(".env", "utf8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

async function main() {
  const env = parseEnv();
  const tokenStore = new TokenStore(resolve(".gflow/publish-tokens.json"));
  const publisher = new Publisher({
    tokens: tokenStore,
    env,
    tiktokProfile: "tiktok",
    headed: true
  });

  const status = await publisher.status();
  console.log("Publisher connection status:", JSON.stringify(status, null, 2));

  console.log("\n>>> Đang tiến hành đăng video lên TikTok (Chế độ: PUBLIC)...");
  const results = await publisher.publish({
    projectRoot: resolve("music-output/tam-biet-tinh-ban-khoi-dau-tinh-yeu"),
    platforms: ["tiktok"],
    privacy: "public",
    metadata: {
      title: "Hơn Cả Tri Kỷ - Tạm Biệt Tình Bạn, Khởi Đầu Tình Yêu",
      description: "Từ đôi bạn thân cùng sẻ chia thanh xuân đến khoảnh khắc rung động, can đảm bước qua ranh giới bạn bè để bắt đầu tình yêu chân thành.\n\n#HonCaTriKy #TamBietTinhBan #KhoiDauTinhYeu #nhacAI #vpop #anime #love",
      tags: ["HonCaTriKy", "TamBietTinhBan", "KhoiDauTinhYeu", "nhacAI", "vpop", "anime", "love"]
    },
    madeForKids: false,
    language: "vi-VN",
    force: true
  });

  console.log("\n>>> Kết quả xuất bản:", JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error("Lỗi đăng video:", err);
  process.exit(1);
});
