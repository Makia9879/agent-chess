import postgres from "postgres";
import type {
  GameStatus,
  MoveView,
  ParticipantSide,
  ParticipantType,
  ParticipantView,
  RoomState,
  RoomStatus
} from "@chess-room/shared";
import { legalMoves, turnFromFen } from "./game";
import { HttpError } from "./http";

export interface DbParticipant {
  id: string;
  room_id: string;
  participant_type: ParticipantType;
  display_name: string;
  side: ParticipantSide;
  token_hash: string;
  joined_at: string;
}

export interface CreateRoomRecord {
  roomId: string;
  roomCode: string;
  gameId: string;
  participantId: string;
  tokenHash: string;
  displayName: string;
  side: ParticipantSide;
  fen: string;
  status: GameStatus;
}

export class Store {
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 });
  }

  async createRoom(input: CreateRoomRecord): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`
        INSERT INTO rooms (id, code, status)
        VALUES (${input.roomId}, ${input.roomCode}, 'waiting')
      `;
      await sql`
        INSERT INTO room_participants (id, room_id, participant_type, display_name, side, token_hash)
        VALUES (${input.participantId}, ${input.roomId}, 'agent', ${input.displayName}, ${input.side}, ${input.tokenHash})
      `;
      await sql`
        INSERT INTO games (id, room_id, fen, status, version)
        VALUES (${input.gameId}, ${input.roomId}, ${input.fen}, ${input.status}, 0)
      `;
    });
  }

  async findRoomIdByCode(code: string): Promise<string | null> {
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM rooms WHERE code = ${code} LIMIT 1`;
    return rows[0]?.id ?? null;
  }

  async addParticipant(input: {
    id: string;
    roomId: string;
    type: ParticipantType;
    displayName: string;
    side: ParticipantSide;
    tokenHash: string;
  }): Promise<void> {
    const sameName = await this.sql<{ id: string }[]>`
      SELECT id FROM room_participants
      WHERE room_id = ${input.roomId}
        AND participant_type = ${input.type}
        AND display_name = ${input.displayName}
      LIMIT 1
    `;
    if (sameName[0]) {
      throw new HttpError("participant_exists", "participant already joined this room", 409);
    }

    if (input.side !== "spectator") {
      const existing = await this.sql<{ id: string }[]>`
        SELECT id FROM room_participants
        WHERE room_id = ${input.roomId} AND side = ${input.side}
        LIMIT 1
      `;
      if (existing[0]) {
        throw new HttpError("side_taken", "side is already taken", 409);
      }
    }
    try {
      await this.sql`
        INSERT INTO room_participants (id, room_id, participant_type, display_name, side, token_hash)
        VALUES (${input.id}, ${input.roomId}, ${input.type}, ${input.displayName}, ${input.side}, ${input.tokenHash})
      `;
    } catch (error) {
      const dbError = error as { code?: string; constraint_name?: string; constraint?: string };
      const constraint = dbError.constraint_name ?? dbError.constraint ?? "";
      if (dbError.code === "23505" && constraint.includes("participant_type_display_name")) {
        throw new HttpError("participant_exists", "participant already joined this room", 409);
      }
      if (dbError.code === "23505" && constraint.includes("playing_side")) {
        throw new HttpError("side_taken", "side is already taken", 409);
      }
      throw error;
    }
  }

  async getParticipantByToken(roomId: string, tokenHash: string): Promise<DbParticipant | null> {
    const rows = await this.sql<DbParticipant[]>`
      SELECT id, room_id, participant_type, display_name, side, token_hash, joined_at::text
      FROM room_participants
      WHERE room_id = ${roomId} AND token_hash = ${tokenHash}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getRoomState(roomId: string): Promise<RoomState> {
    const roomRows = await this.sql<{ id: string; code: string; status: RoomStatus; updated_at: string }[]>`
      SELECT id, code, status, updated_at::text FROM rooms WHERE id = ${roomId} LIMIT 1
    `;
    const room = roomRows[0];
    if (!room) throw new HttpError("room_not_found", "room does not exist", 404);

    const gameRows = await this.sql<{ id: string; fen: string; status: GameStatus; version: number; updated_at: string }[]>`
      SELECT id, fen, status, version, updated_at::text FROM games WHERE room_id = ${roomId} LIMIT 1
    `;
    const game = gameRows[0];
    if (!game) throw new HttpError("game_not_found", "game does not exist", 404);

    const participants = await this.sql<ParticipantView[]>`
      SELECT id AS participant_id, participant_type, display_name, side, joined_at::text
      FROM room_participants
      WHERE room_id = ${roomId}
      ORDER BY joined_at ASC
    `;
    const moves = await this.sql<MoveView[]>`
      SELECT ply, uci, san, actor, participant_id, fen_after, created_at::text
      FROM game_moves
      WHERE game_id = ${game.id}
      ORDER BY ply ASC
    `;

    return {
      room_id: room.id,
      room_code: room.code,
      room_status: room.status,
      participants,
      game_id: game.id,
      fen: game.fen,
      turn: turnFromFen(game.fen),
      status: game.status,
      version: game.version,
      legal_moves: legalMoves(game.fen),
      moves,
      updated_at: game.updated_at
    };
  }

  async recordMove(input: {
    roomId: string;
    gameId: string;
    participantId: string;
    participantType: ParticipantType;
    expectedVersion?: number;
    uci: string;
    san: string;
    fenAfter: string;
    status: GameStatus;
    ipHash: string;
    userAgentHash: string;
  }): Promise<void> {
    await this.sql.begin(async (sql) => {
      const games = await sql<{ version: number }[]>`
        SELECT version FROM games WHERE id = ${input.gameId} AND room_id = ${input.roomId} FOR UPDATE
      `;
      const game = games[0];
      if (!game) throw new HttpError("game_not_found", "game does not exist", 404);
      if (input.expectedVersion !== undefined && input.expectedVersion !== game.version) {
        throw new HttpError("version_conflict", "game version is stale", 409);
      }

      const nextVersion = game.version + 1;
      await sql`
        UPDATE games
        SET fen = ${input.fenAfter}, status = ${input.status}, version = ${nextVersion}, updated_at = now()
        WHERE id = ${input.gameId}
      `;
      await sql`
        INSERT INTO game_moves (game_id, participant_id, ply, uci, san, actor, fen_after, ip_hash, user_agent_hash)
        VALUES (
          ${input.gameId},
          ${input.participantId},
          ${nextVersion},
          ${input.uci},
          ${input.san},
          ${input.participantType},
          ${input.fenAfter},
          ${input.ipHash},
          ${input.userAgentHash}
        )
      `;
    });
  }
}
