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

  console.log("\n>>> Đang tiến hành đăng video lên YouTube & TikTok (Chế độ: PUBLIC)...");
  const results = await publisher.publish({
    projectRoot: resolve("music-output/15-ngay-truoc-khi-hoa-no"),
    platforms: ["youtube", "tiktok"],
    privacy: "public",
    metadata: {
      title: "15 Ngày Trước Khi Hoa Nở - Mười Lăm Ngày Đơm Hoa",
      description: "Mọi sự cố gắng phấn đấu cho một mục tiêu duy nhất, như sự chờ đợi không ngừng nghỉ. 15 ngày cuối thấy hoa sẽ nở rộ, dù kết quả hoa nở thành công hay chỉ ngắn ngủi rồi rụng xuống đều đã cố gắng hết sức của bản thân, không một chút nuối tiếc.\n\n#15ngaytruockhihoano #nhacAI #dongluc #musicvideo #flow #veo",
      tags: ["15ngaytruockhihoano", "nhacAI", "dongluc", "musicvideo", "flow", "veo"]
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
