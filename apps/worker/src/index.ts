import type { CreateRoomRequest } from "@chess-room/shared";
import { loadConfig, type Env } from "./config";
import { createChess, gameStatus, legalMoves } from "./game";
import { error, json, readJson, toErrorResponse, withCors } from "./http";
import { validateDisplayName, roomCode, randomId, randomToken, sha256 } from "./security";
import { Store } from "./store";
export { RoomObject } from "./room-object";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    try {
      const config = loadConfig(env);
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), origin, config.corsAllowOrigins);
      }
      const response = await route(request, env, config.databaseUrl);
      return withCors(response, origin, config.corsAllowOrigins);
    } catch (err) {
      return withCors(toErrorResponse(err), origin, []);
    }
  }
};

async function route(request: Request, env: Env, databaseUrl: string): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    return createRoom(request, env, databaseUrl);
  }

  if (request.method === "POST" && parts[0] === "api" && parts[1] === "rooms" && parts[2] === "by-code" && parts[3] && parts[4] === "join") {
    const body = await readJson<{ display_name: string; side: "white" | "black" | "spectator" }>(request);
    if (body.side === "spectator") {
      return error("invalid_side", "MCP agents must join as white or black", 400);
    }
    const roomCode = parts[3];
    const roomId = await new Store(databaseUrl).findRoomIdByCode(roomCode);
    if (!roomId) {
      return error("room_not_found", "room does not exist", 404);
    }
    const forwarded = new Request(new URL(`/api/rooms/${roomId}/join`, request.url), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ ...body, room_code: roomCode })
    });
    return env.ROOM_OBJECT.get(env.ROOM_OBJECT.idFromName(roomId)).fetch(forwarded);
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const roomId = parts[2];
    if (request.method === "GET" && parts.length === 3) {
      return json(await new Store(databaseUrl).getRoomState(roomId));
    }
    if (request.method === "GET" && parts[3] === "legal-moves") {
      const state = await new Store(databaseUrl).getRoomState(roomId);
      return json({ room_id: roomId, game_id: state.game_id, fen: state.fen, legal_moves: state.legal_moves });
    }
    if (parts[3] === "events" || parts[3] === "moves" || parts[3] === "join") {
      return env.ROOM_OBJECT.get(env.ROOM_OBJECT.idFromName(roomId)).fetch(request);
    }
  }

  return error("not_found", "route not found", 404);
}

async function createRoom(request: Request, env: Env, databaseUrl: string): Promise<Response> {
  const body = await readJson<CreateRoomRequest>(request);
  const config = loadConfig(env);
  const displayName = validateDisplayName(body.display_name);
  const side = body.side ?? "white";
  if (!["white", "black", "spectator"].includes(side)) {
    return error("invalid_side", "side must be white, black, or spectator", 400);
  }
  const chess = createChess(body.fen);
  const roomId = randomId();
  const gameId = randomId();
  const participantId = randomId();
  const participantToken = randomToken();
  const code = roomCode(config.roomCodeLength);
  const store = new Store(databaseUrl);

  await store.createRoom({
    roomId,
    roomCode: code,
    gameId,
    participantId,
    tokenHash: await sha256(participantToken),
    displayName,
    side,
    fen: chess.fen(),
    status: gameStatus(chess)
  });

  const state = await store.getRoomState(roomId);
  return json({ ...state, participant_id: participantId, participant_token: participantToken });
}
