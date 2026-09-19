import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORMS, PublishError, createPkce, createState, writeJsonPrivate } from "./common.js";
import type { FetchFn, Pkce, Platform, Privacy, StoredToken, TokenStore } from "./common.js";
import { tiktokCaption } from "./metadata.js";
import type { VideoMetadata } from "./metadata.js";
import { buildTiktokAuthUrl, ensureTiktokToken, exchangeTiktokCode, uploadTiktokVideo } from "./tiktok.js";
import { buildYoutubeAuthUrl, ensureYoutubeToken, exchangeYoutubeCode, uploadYoutubeVideo } from "./youtube.js";

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export interface PublisherEnvironment {
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
}

export interface PublishRecord {
  platform: Platform;
  status: "published" | "failed";
  /** Privacy actually applied by the platform when it reports one, otherwise the requested one. */
  privacy: Privacy;
  requestedPrivacy?: Privacy;
  at: string;
  id?: string;
  url?: string;
  error?: string;
}

export interface PublishRequest {
  projectRoot: string;
  platforms: Platform[];
  privacy: Privacy;
  metadata: VideoMetadata;
  madeForKids: boolean;
  language: string;
  /** Publish again even if this project was already published to the platform. */
  force?: boolean;
}

export interface PlatformStatus {
  configured: boolean;
  connected: boolean;
}

interface PendingAuth {
  platform: Platform;
  pkce: Pkce;
  redirectUri: string;
  createdAt: number;
}

export function redirectUriFor(platform: Platform, origin: string): string {
  // TikTok's docs use a trailing slash for loopback redirect URIs; both must match what is registered.
  return platform === "tiktok" ? `${origin}/oauth/tiktok/callback/` : `${origin}/oauth/youtube/callback`;
}

export class Publisher {
  private readonly pending = new Map<string, PendingAuth>();

  constructor(
    private readonly options: {
      tokens: TokenStore;
      env: PublisherEnvironment;
      fetcher?: FetchFn;
    }
  ) {}

  private get fetcher(): FetchFn {
    return this.options.fetcher ?? fetch;
  }

  private youtubeConfig() {
    const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = this.options.env;
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  }

  private tiktokConfig() {
    const { TIKTOK_CLIENT_KEY: clientKey, TIKTOK_CLIENT_SECRET: clientSecret } = this.options.env;
    return clientKey && clientSecret ? { clientKey, clientSecret } : undefined;
  }

  async status(): Promise<Record<Platform, PlatformStatus>> {
    return {
      youtube: { configured: Boolean(this.youtubeConfig()), connected: Boolean(await this.options.tokens.get("youtube")) },
      tiktok: { configured: Boolean(this.tiktokConfig()), connected: Boolean(await this.options.tokens.get("tiktok")) }
    };
  }

  /** Returns the consent-screen URL the user must open; the token is stored when `completeAuth` runs. */
  beginAuth(platform: Platform, origin: string): string {
    this.prunePending();
    const redirectUri = redirectUriFor(platform, origin);
    const state = createState();
    if (platform === "youtube") {
      const config = this.youtubeConfig();
      if (!config) throw new PublishError("Chưa cấu hình YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET trong .env", "NOT_CONFIGURED");
      const pkce = createPkce("base64url");
      this.pending.set(state, { platform, pkce, redirectUri, createdAt: Date.now() });
      return buildYoutubeAuthUrl(config, redirectUri, state, pkce.challenge);
    }
    const config = this.tiktokConfig();
    if (!config) throw new PublishError("Chưa cấu hình TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET trong .env", "NOT_CONFIGURED");
    const pkce = createPkce("hex");
    this.pending.set(state, { platform, pkce, redirectUri, createdAt: Date.now() });
    return buildTiktokAuthUrl(config, redirectUri, state, pkce.challenge);
  }

  async completeAuth(platform: Platform, state: string, code: string): Promise<void> {
    this.prunePending();
    const pending = this.pending.get(state);
    // The state is single-use and must belong to the platform whose callback we received.
    this.pending.delete(state);
    if (!pending || pending.platform !== platform) throw new PublishError("Phiên đăng nhập không hợp lệ hoặc đã hết hạn", "BAD_STATE");
    const input = { code, redirectUri: pending.redirectUri, verifier: pending.pkce.verifier };
    let token: StoredToken;
    if (platform === "youtube") {
      const config = this.youtubeConfig();
      if (!config) throw new PublishError("Thiếu cấu hình YouTube", "NOT_CONFIGURED");
      token = await exchangeYoutubeCode(config, this.fetcher, input);
    } else {
      const config = this.tiktokConfig();
      if (!config) throw new PublishError("Thiếu cấu hình TikTok", "NOT_CONFIGURED");
      token = await exchangeTiktokCode(config, this.fetcher, input);
    }
    await this.options.tokens.set(platform, token);
  }

  disconnect(platform: Platform): Promise<void> {
    return this.options.tokens.remove(platform);
  }

  private prunePending(): void {
    const cutoff = Date.now() - PENDING_AUTH_TTL_MS;
    for (const [state, auth] of this.pending) if (auth.createdAt < cutoff) this.pending.delete(state);
  }

  async history(projectRoot: string): Promise<PublishRecord[]> {
    try {
      return JSON.parse(await readFile(join(projectRoot, "publish.json"), "utf8")) as PublishRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Uploads the finished video to each requested platform. A failure on one platform is recorded and
   * does not stop the others; a platform already published for this project is skipped unless forced.
   */
  async publish(request: PublishRequest): Promise<PublishRecord[]> {
    const videoPath = join(request.projectRoot, "output", "final.mp4");
    await stat(videoPath).catch(() => {
      throw new PublishError("Chưa có video hoàn chỉnh để đăng", "NO_VIDEO");
    });
    const platforms = request.platforms.filter((platform, index, all) => PLATFORMS.includes(platform) && all.indexOf(platform) === index);
    if (platforms.length === 0) throw new PublishError("Chưa chọn nền tảng nào để đăng", "NO_PLATFORM");

    const history = await this.history(request.projectRoot);
    const results: PublishRecord[] = [];
    for (const platform of platforms) {
      const existing = history.find((record) => record.platform === platform && record.status === "published");
      if (existing && !request.force) {
        results.push(existing);
        continue;
      }
      const record = await this.publishOne(platform, videoPath, request);
      results.push(record);
      history.push(record);
      await writeJsonPrivate(join(request.projectRoot, "publish.json"), history);
    }
    return results;
  }

  private async publishOne(platform: Platform, videoPath: string, request: PublishRequest): Promise<PublishRecord> {
    const base = { platform, privacy: request.privacy, at: new Date().toISOString() };
    try {
      if (platform === "youtube") {
        const config = this.youtubeConfig();
        const stored = await this.options.tokens.get("youtube");
        if (!config || !stored) throw new PublishError("Chưa kết nối YouTube", "NOT_CONNECTED");
        const token = await ensureYoutubeToken(config, this.fetcher, stored);
        if (token !== stored) await this.options.tokens.set("youtube", token);
        const result = await uploadYoutubeVideo(this.fetcher, token.accessToken, {
          filePath: videoPath,
          title: request.metadata.title,
          description: request.metadata.description,
          tags: request.metadata.tags,
          privacy: request.privacy,
          madeForKids: request.madeForKids,
          language: request.language.split("-")[0] || "vi"
        });
        return {
          ...base,
          privacy: result.privacyStatus ?? request.privacy,
          ...(result.privacyStatus && result.privacyStatus !== request.privacy ? { requestedPrivacy: request.privacy } : {}),
          status: "published",
          id: result.videoId,
          url: result.url
        };
      }
      const config = this.tiktokConfig();
      const stored = await this.options.tokens.get("tiktok");
      if (!config || !stored) throw new PublishError("Chưa kết nối TikTok", "NOT_CONNECTED");
      const token = await ensureTiktokToken(config, this.fetcher, stored);
      if (token !== stored) await this.options.tokens.set("tiktok", token);
      const result = await uploadTiktokVideo(this.fetcher, token.accessToken, {
        filePath: videoPath,
        caption: tiktokCaption(request.metadata),
        privacy: request.privacy,
        allowComments: true
      });
      return { ...base, status: "published", id: result.postId ?? result.publishId, ...(result.url ? { url: result.url } : {}) };
    } catch (error) {
      return { ...base, status: "failed", error: error instanceof Error ? error.message : "Lỗi không xác định" };
    }
  }
}
