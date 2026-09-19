import { stat } from "node:fs/promises";
import { PublishError, describeFailure, readFileRange, tokenIsFresh, wait } from "./common.js";
import type { FetchFn, Privacy, StoredToken } from "./common.js";

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API_BASE = "https://open.tiktokapis.com";
const TOKEN_PATH = "/v2/oauth/token/";
const SCOPE = "video.publish";
const MAX_SINGLE_UPLOAD = 64 * 1024 * 1024;
const LARGE_CHUNK = 32 * 1024 * 1024;
const STATUS_POLL_MS = 5000;
const STATUS_TIMEOUT_MS = 10 * 60 * 1000;

export interface TiktokConfig {
  clientKey: string;
  clientSecret: string;
}

export function buildTiktokAuthUrl(config: TiktokConfig, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_key: config.clientKey,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();
  return url.toString();
}

interface TiktokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
}

async function requestToken(fetcher: FetchFn, body: Record<string, string>): Promise<StoredToken> {
  const response = await fetcher(`${API_BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  if (!response.ok) throw new PublishError(`TikTok từ chối token (${await describeFailure(response)})`, "AUTH_FAILED");
  const data = (await response.json()) as TiktokTokenResponse;
  if (data.error || !data.access_token || !data.refresh_token) {
    throw new PublishError(`TikTok từ chối token${data.error_description ? ` (${data.error_description.slice(0, 200)})` : ""}`, "AUTH_FAILED");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 86_400) * 1000,
    scope: data.scope,
    openId: data.open_id
  };
}

export function exchangeTiktokCode(
  config: TiktokConfig,
  fetcher: FetchFn,
  input: { code: string; redirectUri: string; verifier: string }
): Promise<StoredToken> {
  return requestToken(fetcher, {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier
  });
}

// TikTok may rotate the refresh token on every refresh, so the returned one always replaces the old.
export async function ensureTiktokToken(config: TiktokConfig, fetcher: FetchFn, token: StoredToken): Promise<StoredToken> {
  if (tokenIsFresh(token)) return token;
  return requestToken(fetcher, {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken
  });
}

interface TiktokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

async function callApi<T>(fetcher: FetchFn, accessToken: string, path: string, body: unknown): Promise<T> {
  const response = await fetcher(`${API_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body)
  });
  let envelope: TiktokEnvelope<T> = {};
  try {
    envelope = (await response.clone().json()) as TiktokEnvelope<T>;
  } catch {
    envelope = {};
  }
  const code = envelope.error?.code;
  if (!response.ok || (code && code !== "ok")) {
    const detail = code ? `${code}${envelope.error?.message ? ` — ${envelope.error.message.slice(0, 200)}` : ""}` : await describeFailure(response);
    throw new PublishError(`TikTok lỗi (${detail})`, code ?? "TIKTOK_ERROR");
  }
  return (envelope.data ?? {}) as T;
}

export interface TiktokCreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export function queryTiktokCreator(fetcher: FetchFn, accessToken: string): Promise<TiktokCreatorInfo> {
  return callApi<TiktokCreatorInfo>(fetcher, accessToken, "/v2/post/publish/creator_info/query/", {});
}

export type TiktokPrivacyLevel = "PUBLIC_TO_EVERYONE" | "SELF_ONLY";

export function tiktokPrivacyLevel(privacy: Privacy): TiktokPrivacyLevel {
  if (privacy === "public") return "PUBLIC_TO_EVERYONE";
  if (privacy === "private") return "SELF_ONLY";
  throw new PublishError("TikTok không có chế độ “Không công khai”; hãy chọn Riêng tư hoặc Công khai", "UNSUPPORTED_PRIVACY");
}

export interface ChunkPlan {
  chunkSize: number;
  totalChunks: number;
}

// TikTok wants chunk_size and total_chunk_count = floor(size / chunk_size); the final chunk absorbs
// the remainder. Anything up to 64 MB can go up whole, which is the simplest valid plan.
export function planTiktokChunks(size: number): ChunkPlan {
  if (size <= 0) throw new PublishError("Tệp video rỗng");
  if (size <= MAX_SINGLE_UPLOAD) return { chunkSize: size, totalChunks: 1 };
  return { chunkSize: LARGE_CHUNK, totalChunks: Math.floor(size / LARGE_CHUNK) };
}

export function chunkRange(plan: ChunkPlan, size: number, index: number): { start: number; end: number } {
  const start = index * plan.chunkSize;
  const end = index === plan.totalChunks - 1 ? size - 1 : start + plan.chunkSize - 1;
  return { start, end };
}

export interface TiktokUploadInput {
  filePath: string;
  caption: string;
  privacy: Privacy;
  allowComments: boolean;
}

export interface TiktokUploadResult {
  publishId: string;
  postId?: string;
  url?: string;
}

interface InitResponse {
  publish_id?: string;
  upload_url?: string;
}

interface StatusResponse {
  status?: string;
  fail_reason?: string;
  publicaly_available_post_id?: Array<string | number>;
}

export async function uploadTiktokVideo(
  fetcher: FetchFn,
  accessToken: string,
  input: TiktokUploadInput,
  options: { sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number } = {}
): Promise<TiktokUploadResult> {
  const sleep = options.sleep ?? wait;
  const pollMs = options.pollMs ?? STATUS_POLL_MS;
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const size = (await stat(input.filePath)).size;
  const plan = planTiktokChunks(size);

  const creator = await queryTiktokCreator(fetcher, accessToken);
  const level = tiktokPrivacyLevel(input.privacy);
  if (creator.privacy_level_options && !creator.privacy_level_options.includes(level)) {
    throw new PublishError(`Tài khoản TikTok này không cho phép chế độ ${level} (được phép: ${creator.privacy_level_options.join(", ")})`, "PRIVACY_NOT_ALLOWED");
  }

  const init = await callApi<InitResponse>(fetcher, accessToken, "/v2/post/publish/video/init/", {
    post_info: {
      title: input.caption.slice(0, 2200),
      privacy_level: level,
      disable_comment: !input.allowComments || creator.comment_disabled === true,
      // Always disclose: the video and its music are AI-generated.
      is_aigc: true
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunks
    }
  });
  if (!init.publish_id || !init.upload_url) throw new PublishError("TikTok không trả về địa chỉ tải lên");

  for (let index = 0; index < plan.totalChunks; index += 1) {
    const { start, end } = chunkRange(plan, size, index);
    const chunk = await readFileRange(input.filePath, start, end);
    const response = await fetcher(init.upload_url, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}` },
      body: chunk
    });
    if (response.status !== 201 && response.status !== 206 && response.status !== 200) {
      throw new PublishError(`TikTok lỗi khi tải lên (${await describeFailure(response)})`);
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await callApi<StatusResponse>(fetcher, accessToken, "/v2/post/publish/status/fetch/", { publish_id: init.publish_id });
    if (status.status === "PUBLISH_COMPLETE") {
      const postId = status.publicaly_available_post_id?.[0] !== undefined ? String(status.publicaly_available_post_id[0]) : undefined;
      const url = postId && creator.creator_username ? `https://www.tiktok.com/@${creator.creator_username}/video/${postId}` : undefined;
      return { publishId: init.publish_id, postId, url };
    }
    if (status.status === "FAILED") {
      throw new PublishError(`TikTok xử lý video thất bại (${status.fail_reason ?? "không rõ lý do"})`);
    }
    await sleep(pollMs);
  }
  throw new PublishError("Hết thời gian chờ TikTok xử lý video (video có thể vẫn đang được xử lý phía TikTok)");
}
