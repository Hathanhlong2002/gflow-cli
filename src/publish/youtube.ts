import { stat } from "node:fs/promises";
import { PublishError, describeFailure, readFileRange, tokenIsFresh, wait } from "./common.js";
import type { FetchFn, Privacy, StoredToken } from "./common.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
// Least privilege: upload only, no read/manage access to the channel.
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const MUSIC_CATEGORY_ID = "10";
// Resumable-upload chunks must be a multiple of 256 KiB.
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;

export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
}

export interface YoutubeUploadInput {
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  privacy: Privacy;
  madeForKids: boolean;
  language: string;
}

export function buildYoutubeAuthUrl(config: YoutubeConfig, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    // Without prompt=consent Google omits the refresh token on repeat sign-ins.
    prompt: "consent"
  }).toString();
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function requestToken(fetcher: FetchFn, body: Record<string, string>, fallbackRefresh?: string): Promise<StoredToken> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString()
  });
  if (!response.ok) throw new PublishError(`Google từ chối token (${await describeFailure(response)})`, "AUTH_FAILED");
  const data = (await response.json()) as GoogleTokenResponse;
  const refreshToken = data.refresh_token ?? fallbackRefresh;
  if (!data.access_token || !refreshToken) throw new PublishError("Google không trả về token hợp lệ", "AUTH_FAILED");
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope
  };
}

export function exchangeYoutubeCode(
  config: YoutubeConfig,
  fetcher: FetchFn,
  input: { code: string; redirectUri: string; verifier: string }
): Promise<StoredToken> {
  return requestToken(fetcher, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });
}

export async function ensureYoutubeToken(config: YoutubeConfig, fetcher: FetchFn, token: StoredToken): Promise<StoredToken> {
  if (tokenIsFresh(token)) return token;
  return requestToken(
    fetcher,
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken
    },
    token.refreshToken
  );
}

// YouTube rejects titles/descriptions/tags containing angle brackets.
function stripAngleBrackets(value: string): string {
  return value.replace(/[<>]/g, "");
}

export function buildYoutubeResource(input: YoutubeUploadInput): Record<string, unknown> {
  // Tags are capped at 500 characters combined (quoted tags with spaces count extra).
  const tags: string[] = [];
  let budget = 480;
  for (const raw of input.tags) {
    const tag = stripAngleBrackets(raw).trim();
    const cost = tag.length + (tag.includes(" ") ? 2 : 0) + 1;
    if (tag.length === 0 || cost > budget) continue;
    tags.push(tag);
    budget -= cost;
  }
  return {
    snippet: {
      title: stripAngleBrackets(input.title).trim().slice(0, 100),
      description: stripAngleBrackets(input.description).slice(0, 4900),
      tags,
      categoryId: MUSIC_CATEGORY_ID,
      defaultLanguage: input.language,
      defaultAudioLanguage: input.language
    },
    status: {
      privacyStatus: input.privacy,
      selfDeclaredMadeForKids: input.madeForKids,
      // Always disclose: the video and its music are AI-generated.
      containsSyntheticMedia: true
    }
  };
}

export interface YoutubeUploadResult {
  videoId: string;
  url: string;
  /** Privacy YouTube actually applied; unaudited API projects are forced to "private" whatever was requested. */
  privacyStatus?: Privacy;
}

export async function uploadYoutubeVideo(
  fetcher: FetchFn,
  accessToken: string,
  input: YoutubeUploadInput,
  options: { chunkBytes?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<YoutubeUploadResult> {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const sleep = options.sleep ?? wait;
  const size = (await stat(input.filePath)).size;
  if (size <= 0) throw new PublishError("Tệp video rỗng");

  const init = await fetcher(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4"
    },
    body: JSON.stringify(buildYoutubeResource(input))
  });
  if (!init.ok) throw new PublishError(`YouTube từ chối khởi tạo tải lên (${await describeFailure(init)})`);
  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new PublishError("YouTube không trả về địa chỉ tải lên");

  let offset = 0;
  let failures = 0;
  while (offset < size) {
    const end = Math.min(offset + chunkBytes, size) - 1;
    const chunk = await readFileRange(input.filePath, offset, end);
    let response: Response;
    try {
      response = await fetcher(sessionUrl, {
        method: "PUT",
        headers: { "content-range": `bytes ${offset}-${end}/${size}`, "content-type": "video/mp4" },
        body: chunk
      });
    } catch {
      response = new Response(null, { status: 503 });
    }

    if (response.status === 200 || response.status === 201) {
      const data = (await response.json()) as { id?: string; status?: { privacyStatus?: string } };
      if (!data.id) throw new PublishError("YouTube không trả về mã video");
      const applied = data.status?.privacyStatus;
      return {
        videoId: data.id,
        url: `https://www.youtube.com/watch?v=${data.id}`,
        ...(applied === "private" || applied === "unlisted" || applied === "public" ? { privacyStatus: applied } : {})
      };
    }
    if (response.status === 308) {
      offset = nextOffset(response);
      failures = 0;
      continue;
    }
    if (response.status >= 500 && failures < MAX_CHUNK_RETRIES) {
      failures += 1;
      await sleep(2000 * failures);
      offset = await queryResumeOffset(fetcher, sessionUrl, size);
      continue;
    }
    throw new PublishError(`YouTube lỗi khi tải lên (${await describeFailure(response)})`);
  }
  throw new PublishError("YouTube không xác nhận hoàn tất tải lên");
}

function nextOffset(response: Response): number {
  const range = response.headers.get("range");
  const match = range ? /-(\d+)$/.exec(range) : null;
  return match ? Number(match[1]) + 1 : 0;
}

async function queryResumeOffset(fetcher: FetchFn, sessionUrl: string, size: number): Promise<number> {
  const response = await fetcher(sessionUrl, { method: "PUT", headers: { "content-range": `bytes */${size}` } });
  if (response.status === 308) return nextOffset(response);
  throw new PublishError(`Không tiếp tục được lượt tải lên YouTube (${await describeFailure(response)})`);
}
