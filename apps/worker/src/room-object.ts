import type { JoinRoomRequest, SubmitMoveRequest } from "@chess-room/shared";
import { applyUci } from "./game";
import { error, HttpError, json, readJson, toErrorResponse } from "./http";
import { loadConfig, type Env } from "./config";
import { randomId, randomToken, sha256, validateDisplayName } from "./security";
import { Store } from "./store";

export class RoomObject implements DurableObject {
  private readonly sockets = new Set<WebSocket>();
  private readonly lastSeenAt = new Map<WebSocket, number>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const roomId = url.pathname.split("/")[3];
      if (!roomId) return error("room_not_found", "room id is required", 404);

      if (url.pathname.endsWith("/events")) {
        return this.handleWebSocket();
      }
      if (url.pathname.endsWith("/join") && request.method === "POST") {
        return this.handleJoin(roomId, request);
      }
      if (url.pathname.endsWith("/moves") && request.method === "POST") {
        return this.handleMove(roomId, request);
      }
      return error("not_found", "route not found", 404);
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    this.lastSeenAt.set(server, Date.now());
    server.addEventListener("message", (event) => {
      if (event.data === "pong") {
        this.lastSeenAt.set(server, Date.now());
        return;
      }
      if (typeof event.data === "string") {
        try {
          if (JSON.parse(event.data).type === "pong") this.lastSeenAt.set(server, Date.now());
        } catch {
          this.lastSeenAt.set(server, Date.now());
        }
      }
    });
    server.addEventListener("close", () => this.dropSocket(server));
    server.addEventListener("error", () => this.dropSocket(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleJoin(roomId: string, request: Request): Promise<Response> {
    const body = await readJson<JoinRoomRequest>(request);
    const displayName = validateDisplayName(body.display_name);
    if (!["white", "black"].includes(body.side)) {
      throw new HttpError("invalid_side", "MCP agents must join as white or black", 400);
    }
    const config = loadConfig(this.env);
    const store = new Store(config.databaseUrl);
    const participantId = randomId();
    const participantToken = randomToken();
    await store.addParticipant({
      id: participantId,
      roomId,
      type: "agent",
      displayName,
      side: body.side,
      tokenHash: await sha256(participantToken)
    });
    const state = await store.getRoomState(roomId);
    this.broadcast({ type: "room.participant_joined", room_id: roomId, participant: state.participants.find((p) => p.participant_id === participantId)! });
    return json({ ...state, participant_id: participantId, participant_token: participantToken });
  }

  private async handleMove(roomId: string, request: Request): Promise<Response> {
    const body = await readJson<SubmitMoveRequest>(request);
    const config = loadConfig(this.env);
    const store = new Store(config.databaseUrl);
    const tokenHash = await sha256(body.participant_token);
    const participant = await store.getParticipantByToken(roomId, tokenHash);
    if (!participant) {
      throw new HttpError("unauthorized_participant", "participant token is invalid", 401);
    }

    const before = await store.getRoomState(roomId);
    if (before.status !== "active") {
      throw new HttpError("game_finished", "game is already finished", 409);
    }
    if (participant.side === "spectator" || participant.side !== before.turn) {
      throw new HttpError("not_your_turn", "participant is not current side to move", 403);
    }

    const move = applyUci(before.fen, body.uci);
    const recordInput = {
      roomId,
      gameId: before.game_id,
      participantId: participant.id,
      participantType: participant.participant_type,
      uci: body.uci,
      san: move.san,
      fenAfter: move.fen,
      status: move.status,
      ipHash: await sha256(request.headers.get("cf-connecting-ip") ?? ""),
      userAgentHash: await sha256(request.headers.get("user-agent") ?? "")
    };
    await store.recordMove(
      body.expected_version === undefined
        ? recordInput
        : { ...recordInput, expectedVersion: body.expected_version }
    );
    const after = await store.getRoomState(roomId);
    this.broadcast({
      type: "game.updated",
      room_id: roomId,
      game_id: after.game_id,
      fen: after.fen,
      last_move: body.uci,
      turn: after.turn,
      status: after.status,
      version: after.version,
      legal_moves: after.legal_moves
    });
    return json(after);
  }

  private broadcast(event: unknown): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.dropSocket(socket);
      }
    }
  }

  private dropSocket(socket: WebSocket): void {
    this.sockets.delete(socket);
    this.lastSeenAt.delete(socket);
  }
}
