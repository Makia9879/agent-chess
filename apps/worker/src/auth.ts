import type {
  CurrentUserResponse,
  LogoutResponse,
  UserRoomsResponse,
  WalletChallengeRequest,
  WalletChallengeResponse,
  WalletVerifyRequest
} from "@chess-room/shared";
import { isAddress, verifyMessage } from "viem";
import type { AppConfig } from "./config";
import { clearCookie, error, getCookie, HttpError, json, readJson, setCookie } from "./http";
import { randomId, randomToken, requireString, sha256 } from "./security";
import { Store } from "./store";

const sessionCookieName = "car_session";
const oauthStateCookieName = "car_oauth_state";
const supportedChainIds = new Set(["143", "10143"]);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export async function getSessionUser(store: Store, request: Request): Promise<string | null> {
  const token = getCookie(request, sessionCookieName);
  if (!token) return null;
  return store.getSessionUser(await sha256(token));
}

export async function startGoogleAuth(request: Request, store: Store, config: AppConfig): Promise<Response> {
  rateLimit(request, "google_start", 20);
  requireGoogleConfig(config);

  const state = randomToken();
  const codeVerifier = base64UrlRandom(32);
  const stateCookieToken = randomToken();
  const sessionToken = getCookie(request, sessionCookieName);
  const sessionTokenHash = sessionToken ? await sha256(sessionToken) : "";
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await store.createOauthState({
    id: randomId(),
    state,
    codeVerifier,
    sessionTokenHash,
    stateCookieHash: await sha256(stateCookieToken),
    expiresAt
  });

  const params = new URLSearchParams({
    client_id: config.googleClientId!,
    redirect_uri: config.googleRedirectUri!,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  const response = new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    }
  });
  response.headers.append("set-cookie", setCookie(oauthStateCookieName, stateCookieToken, { maxAge: 10 * 60, secure: isSecure(request) }));
  return response;
}

export async function handleGoogleCallback(request: Request, store: Store, config: AppConfig): Promise<Response> {
  rateLimit(request, "google_callback", 20);
  requireGoogleConfig(config);

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) {
    throw new HttpError("invalid_oauth_state", "oauth state is invalid", 400);
  }

  const oauthState = await store.consumeOauthState(state);
  if (!oauthState) {
    throw new HttpError("invalid_oauth_state", "oauth state is invalid", 400);
  }
  if (new Date(oauthState.expires_at).getTime() <= Date.now()) {
    throw new HttpError("invalid_oauth_state", "oauth state is expired", 400);
  }

  const stateCookieToken = getCookie(request, oauthStateCookieName);
  if (!stateCookieToken || (await sha256(stateCookieToken)) !== oauthState.state_cookie_hash) {
    throw new HttpError("invalid_oauth_state", "oauth state is invalid", 400);
  }

  const sessionToken = getCookie(request, sessionCookieName);
  const currentSessionHash = sessionToken ? await sha256(sessionToken) : "";
  if (oauthState.session_token_hash && oauthState.session_token_hash !== currentSessionHash) {
    throw new HttpError("invalid_oauth_state", "oauth state is invalid", 400);
  }
  const currentUserId = currentSessionHash ? await store.getSessionUser(currentSessionHash) : null;

  const tokenResponse = await exchangeGoogleCode(code, oauthState.code_verifier, config);
  const claims = await verifyGoogleIdToken(tokenResponse.id_token, config.googleClientId!);
  const displayName = normalizeDisplayName(typeof claims.name === "string" ? claims.name : "");
  const userId = await store.findOrCreateGoogleUser({
    currentUserId,
    subject: requireClaim(claims.sub, "sub"),
    email: typeof claims.email === "string" ? claims.email : "",
    emailVerified: claims.email_verified === true,
    displayName,
    userId: randomId(),
    identityId: randomId()
  });

  const response = new Response(null, {
    status: 302,
    headers: { location: `${config.webBaseUrl}/` }
  });
  await attachSessionCookie(response, request, store, userId, config.sessionMaxAgeSeconds);
  response.headers.append("set-cookie", clearCookie(oauthStateCookieName, isSecure(request)));
  return response;
}

export async function createWalletChallenge(request: Request, store: Store): Promise<Response> {
  rateLimit(request, "wallet_challenge", 20);
  const body = await readJson<WalletChallengeRequest>(request);
  const address = normalizeAddress(body.wallet_address);
  const chainId = normalizeChainId(body.chain_id);
  const nonce = randomToken();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
  const message = [
    "Chess Agent Room wants you to sign in with your EVM wallet.",
    "",
    "Domain: Chess Agent Room",
    `Statement: Sign in to Chess Agent Room.`,
    `Address: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expires At: ${expiresAt.toISOString()}`
  ].join("\n");

  await store.createWalletChallenge({
    id: randomId(),
    nonce,
    address,
    chainId,
    statement: message,
    expiresAt: expiresAt.toISOString()
  });

  const response: WalletChallengeResponse = { nonce, message, expires_at: expiresAt.toISOString() };
  return json(response);
}

export async function verifyWallet(request: Request, store: Store, config: AppConfig): Promise<Response> {
  const body = await readJson<WalletVerifyRequest>(request);
  const address = normalizeAddress(body.wallet_address);
  rateLimit(request, `wallet_verify:${address}`, 10);
  const chainId = normalizeChainId(body.chain_id);
  const nonce = requireString(body.nonce, "nonce");
  const signature = requireString(body.signature, "signature");

  const challenge = await store.consumeWalletChallenge({ nonce, address });
  if (!challenge) {
    throw new HttpError("challenge_not_found", "wallet challenge does not exist", 400);
  }
  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    throw new HttpError("challenge_expired", "wallet challenge is expired", 400);
  }
  if (challenge.chain_id !== chainId) {
    throw new HttpError("wallet_chain_mismatch", "wallet chain id does not match challenge", 400);
  }

  const valid = await verifyMessage({ address: address as `0x${string}`, message: challenge.statement, signature: signature as `0x${string}` }).catch(() => false);
  if (!valid) {
    throw new HttpError("invalid_wallet_signature", "wallet signature is invalid", 401);
  }

  const currentUserId = await getSessionUser(store, request);
  const userId = await store.findOrCreateWalletUser({
    currentUserId,
    address,
    chainId,
    userId: randomId(),
    identityId: randomId()
  });
  const response = json({ user: await store.getCurrentUser(userId) });
  await attachSessionCookie(response, request, store, userId, config.sessionMaxAgeSeconds);
  return response;
}

export async function getMe(request: Request, store: Store): Promise<Response> {
  const userId = await getSessionUser(store, request);
  const response: CurrentUserResponse = { user: userId ? await store.getCurrentUser(userId) : null };
  return json(response);
}

export async function logout(request: Request, store: Store): Promise<Response> {
  const token = getCookie(request, sessionCookieName);
  if (token) {
    await store.revokeSession(await sha256(token));
  }
  const body: LogoutResponse = { ok: true };
  const response = json(body);
  response.headers.append("set-cookie", clearCookie(sessionCookieName, isSecure(request)));
  return response;
}

export async function listMyRooms(request: Request, store: Store): Promise<Response> {
  const userId = await getSessionUser(store, request);
  if (!userId) {
    return error("unauthenticated", "login required", 401);
  }
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const listInput: { userId: string; limit: number; cursor?: { updated_at: string; room_id: string } } = {
    userId,
    limit: limit + 1
  };
  if (cursor) listInput.cursor = cursor;
  const rows = await store.listUserRooms(listInput);
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  const response: UserRoomsResponse = {
    rooms: visible,
    next_cursor: rows.length > limit && last ? encodeCursor({ updated_at: last.updated_at, room_id: last.room_id }) : null
  };
  return json(response);
}

async function attachSessionCookie(response: Response, request: Request, store: Store, userId: string, maxAgeSeconds: number): Promise<void> {
  const token = randomToken();
  await store.createSession({
    id: randomId(),
    userId,
    tokenHash: await sha256(token),
    userAgentHash: await sha256(request.headers.get("user-agent") ?? ""),
    ipHash: await sha256(request.headers.get("cf-connecting-ip") ?? ""),
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString()
  });
  response.headers.append("set-cookie", setCookie(sessionCookieName, token, { maxAge: maxAgeSeconds, secure: isSecure(request) }));
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new HttpError("invalid_wallet_address", "wallet address is invalid", 400);
  }
  return value.toLowerCase();
}

function normalizeChainId(value: unknown): "143" | "10143" {
  if (value !== "143" && value !== "10143") {
    throw new HttpError("unsupported_chain_id", "wallet chain id is not supported", 400);
  }
  return value;
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName) return "Google User";
  return displayName.slice(0, 64);
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return 20;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50 || String(parsed) !== value) {
    throw new HttpError("invalid_pagination", "limit must be between 1 and 50", 400);
  }
  return parsed;
}

function parseCursor(value: string | null): { updated_at: string; room_id: string } | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(base64UrlDecodeToString(value)) as { updated_at?: unknown; room_id?: unknown };
    if (typeof decoded.updated_at !== "string" || typeof decoded.room_id !== "string") {
      throw new Error("invalid cursor");
    }
    return { updated_at: decoded.updated_at, room_id: decoded.room_id };
  } catch {
    throw new HttpError("invalid_pagination", "cursor is invalid", 400);
  }
}

function encodeCursor(cursor: { updated_at: string; room_id: string }): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(cursor)));
}

function requireGoogleConfig(config: AppConfig): void {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new HttpError("config_error", "google oauth config is missing", 500);
  }
}

function rateLimit(request: Request, name: string, maxPerMinute: number): void {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const key = `${name}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > maxPerMinute) {
    throw new HttpError("rate_limited", "too many requests", 429);
  }
}

async function exchangeGoogleCode(code: string, codeVerifier: string, config: AppConfig): Promise<{ id_token: string }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId!,
      client_secret: config.googleClientSecret!,
      redirect_uri: config.googleRedirectUri!,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier
    })
  });
  const body = (await response.json().catch(() => undefined)) as { id_token?: string } | undefined;
  if (!response.ok || !body?.id_token) {
    throw new HttpError("oauth_exchange_failed", "google oauth code exchange failed", 400);
  }
  return { id_token: body.id_token };
}

async function verifyGoogleIdToken(idToken: string, audience: string): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HttpError("invalid_google_token", "google id token is invalid", 401);
  }
  const header = JSON.parse(base64UrlDecodeToString(parts[0])) as { kid?: string; alg?: string };
  const claims = JSON.parse(base64UrlDecodeToString(parts[1])) as Record<string, unknown>;
  if (header.alg !== "RS256" || !header.kid) {
    throw new HttpError("invalid_google_token", "google id token is invalid", 401);
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new HttpError("invalid_google_token", "google id token issuer is invalid", 401);
  }
  if (claims.aud !== audience || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new HttpError("invalid_google_token", "google id token is expired or has invalid audience", 401);
  }

  const jwks = (await (await fetch("https://www.googleapis.com/oauth2/v3/certs")).json()) as {
    keys?: (JsonWebKey & { kid?: string })[];
  };
  const key = jwks.keys?.find((item) => item.kid === header.kid);
  if (!key) {
    throw new HttpError("invalid_google_token", "google id token key is unknown", 401);
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) {
    throw new HttpError("invalid_google_token", "google id token signature is invalid", 401);
  }
  return claims;
}

function requireClaim(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError("invalid_google_token", `google id token ${name} is missing`, 401);
  }
  return value;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlDecodeToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}
