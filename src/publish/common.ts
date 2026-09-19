import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type Platform = "youtube" | "tiktok";
export const PLATFORMS: readonly Platform[] = ["youtube", "tiktok"];
export type Privacy = "private" | "unlisted" | "public";

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class PublishError extends Error {
  constructor(message: string, readonly code = "PUBLISH_ERROR") {
    super(message);
    this.name = "PublishError";
  }
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which accessToken stops being valid. */
  expiresAt: number;
  scope?: string;
  openId?: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

// Google expects the RFC 7636 base64url S256 challenge; TikTok's docs require the SHA-256
// digest hex-encoded instead, so the encoding is selectable per platform.
export function createPkce(encoding: "base64url" | "hex"): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest(encoding);
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(24).toString("base64url");
}

export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function tokenIsFresh(token: StoredToken, now = Date.now()): boolean {
  return token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now;
}

// Refresh tokens are long-lived credentials for the user's accounts: keep the file private
// (0600) and never log its contents.
export class TokenStore {
  constructor(private readonly path: string) {}

  private async readAll(): Promise<Partial<Record<Platform, StoredToken>>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Partial<Record<Platform, StoredToken>>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(platform: Platform): Promise<StoredToken | undefined> {
    return (await this.readAll())[platform];
  }

  async set(platform: Platform, token: StoredToken): Promise<void> {
    const all = await this.readAll();
    all[platform] = token;
    await writeJsonPrivate(this.path, all);
  }

  async remove(platform: Platform): Promise<void> {
    const all = await this.readAll();
    delete all[platform];
    await writeJsonPrivate(this.path, all);
  }
}

export async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Short, secret-free description of a failed HTTP response for error messages. */
export async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await response.text()).slice(0, 2000);
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === "string") detail = error;
    else if (error && typeof error === "object") detail = String((error as { message?: unknown }).message ?? "");
    else if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    detail = "";
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return detail ? `HTTP ${response.status} — ${detail}` : `HTTP ${response.status}`;
}

export async function readFileRange(filePath: string, start: number, endInclusive: number): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await open(filePath, "r");
  try {
    const length = endInclusive - start + 1;
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) throw new PublishError("Tệp video thay đổi trong lúc tải lên");
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
