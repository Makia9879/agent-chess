import type {
  CreateRoomRequest,
  CreateRoomResponse,
  CurrentUserResponse,
  RoomState,
  SubmitMoveRequest,
  WalletChallengeRequest,
  WalletChallengeResponse,
  WalletVerifyRequest
} from "@chess-room/shared";

const workerBaseUrl = process.env.NEXT_PUBLIC_WORKER_BASE_URL ?? "http://localhost:8787";
const wsBaseUrl = process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8787";

export async function createRoom(input: CreateRoomRequest): Promise<CreateRoomResponse> {
  return post("/api/rooms", input);
}

export async function getRoom(roomId: string): Promise<RoomState> {
  return get(`/api/rooms/${roomId}`);
}

export async function submitMove(roomId: string, input: SubmitMoveRequest): Promise<RoomState> {
  return post(`/api/rooms/${roomId}/moves`, input);
}

export async function getMe(): Promise<CurrentUserResponse> {
  return get("/api/me");
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout", {});
}

export async function requestWalletChallenge(input: WalletChallengeRequest): Promise<WalletChallengeResponse> {
  return post("/api/auth/wallet/challenge", input);
}

export async function verifyWalletLogin(input: WalletVerifyRequest): Promise<CurrentUserResponse> {
  return post("/api/auth/wallet/verify", input);
}

export function roomEventsUrl(roomId: string): string {
  return `${wsBaseUrl}/api/rooms/${roomId}/events`;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${workerBaseUrl}${path}`, { cache: "no-store", credentials: "include" });
  return parseResponse<T>(response);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${workerBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "include"
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? JSON.stringify(body.error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}
