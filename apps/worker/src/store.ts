import postgres from "postgres";
import type {
  CurrentUserView,
  GameStatus,
  MoveView,
  ParticipantSide,
  ParticipantType,
  ParticipantView,
  RoomState,
  RoomStatus,
  UserRoomSummary
} from "@chess-room/shared";
import { legalMoves, turnFromFen } from "./game";
import { HttpError } from "./http";
import { sha256 } from "./security";

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
  createdByUserId?: string | null;
}

export class Store {
  private readonly sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5 });
  }

  async createRoom(input: CreateRoomRecord): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`
        INSERT INTO rooms (id, code, status, created_by_user_id)
        VALUES (${input.roomId}, ${input.roomCode}, 'waiting', ${input.createdByUserId ?? null})
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

  async getSessionUser(tokenHash: string): Promise<string | null> {
    const rows = await this.sql<{ user_id: string }[]>`
      SELECT user_id
      FROM user_sessions
      WHERE token_hash = ${tokenHash}
        AND expires_at > now()
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return rows[0]?.user_id ?? null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.sql`
      UPDATE user_sessions
      SET revoked_at = now()
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
    `;
  }

  async createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    userAgentHash: string;
    ipHash: string;
    expiresAt: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO user_sessions (id, user_id, token_hash, user_agent_hash, ip_hash, expires_at)
      VALUES (${input.id}, ${input.userId}, ${input.tokenHash}, ${input.userAgentHash}, ${input.ipHash}, ${input.expiresAt})
    `;
  }

  async getCurrentUser(userId: string): Promise<CurrentUserView | null> {
    const users = await this.sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name
      FROM users
      WHERE id = ${userId}
      LIMIT 1
    `;
    const user = users[0];
    if (!user) return null;

    const identities = await this.sql<
      {
        provider: "google" | "wallet";
        email: string;
        email_verified: boolean;
        wallet_namespace: "evm";
        wallet_address: string;
        wallet_chain_id: "143" | "10143" | "";
      }[]
    >`
      SELECT provider, email, email_verified, wallet_namespace, wallet_address, wallet_chain_id
      FROM user_identities
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
    `;
    const google = identities.find((identity) => identity.provider === "google" && identity.email);
    const wallet = identities.find((identity) => identity.provider === "wallet" && identity.wallet_address);
    return {
      user_id: user.id,
      display_name: user.display_name || google?.email || shortAddress(wallet?.wallet_address ?? "") || "User",
      avatar_url: google?.email
        ? `https://www.gravatar.com/avatar/${await sha256(google.email.trim().toLowerCase())}?d=identicon`
        : `https://www.gravatar.com/avatar/${await sha256(wallet?.wallet_address ?? user.id)}?d=identicon`,
      identities: identities.map((identity) =>
        identity.provider === "google"
          ? { provider: "google", email: identity.email, email_verified: identity.email_verified }
          : {
              provider: "wallet",
              wallet_namespace: "evm",
              wallet_address: identity.wallet_address,
              wallet_chain_id: identity.wallet_chain_id === "143" ? "143" : "10143"
            }
      )
    };
  }

  async findOrCreateGoogleUser(input: {
    currentUserId: string | null;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
    userId: string;
    identityId: string;
  }): Promise<string> {
    return this.sql.begin(async (sql) => {
      const existing = await sql<{ user_id: string }[]>`
        SELECT user_id FROM user_identities
        WHERE provider = 'google' AND provider_subject = ${input.subject}
        LIMIT 1
      `;
      const existingUserId = existing[0]?.user_id;
      if (existingUserId && input.currentUserId && existingUserId !== input.currentUserId) {
        throw new HttpError("identity_already_bound", "identity is already bound to another user", 409);
      }

      const userId = existingUserId ?? input.currentUserId ?? input.userId;
      if (!existingUserId && !input.currentUserId) {
        await sql`
          INSERT INTO users (id, display_name, last_login_at)
          VALUES (${userId}, ${input.displayName}, now())
        `;
      } else {
        await sql`
          UPDATE users
          SET last_login_at = now(),
              display_name = CASE WHEN display_name = '' THEN ${input.displayName} ELSE display_name END,
              updated_at = now()
          WHERE id = ${userId}
        `;
      }

      if (existingUserId) {
        await sql`
          UPDATE user_identities
          SET email = ${input.email},
              email_verified = ${input.emailVerified},
              display_name = ${input.displayName},
              updated_at = now()
          WHERE provider = 'google' AND provider_subject = ${input.subject}
        `;
      } else {
        await sql`
          INSERT INTO user_identities (
            id, user_id, provider, provider_subject, email, email_verified, display_name
          )
          VALUES (
            ${input.identityId}, ${userId}, 'google', ${input.subject}, ${input.email}, ${input.emailVerified}, ${input.displayName}
          )
        `;
      }

      return userId;
    });
  }

  async createWalletChallenge(input: {
    id: string;
    nonce: string;
    address: string;
    chainId: string;
    statement: string;
    expiresAt: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO wallet_challenges (id, nonce, wallet_namespace, wallet_address, chain_id, statement, expires_at)
      VALUES (${input.id}, ${input.nonce}, 'evm', ${input.address}, ${input.chainId}, ${input.statement}, ${input.expiresAt})
    `;
  }

  async consumeWalletChallenge(input: { nonce: string; address: string }): Promise<{
    nonce: string;
    wallet_address: string;
    chain_id: string;
    statement: string;
    expires_at: string;
  } | null> {
    const rows = await this.sql<{
      nonce: string;
      wallet_address: string;
      chain_id: string;
      statement: string;
      expires_at: string;
    }[]>`
      UPDATE wallet_challenges
      SET consumed_at = now()
      WHERE nonce = ${input.nonce}
        AND wallet_namespace = 'evm'
        AND wallet_address = ${input.address}
        AND consumed_at IS NULL
      RETURNING nonce, wallet_address, chain_id, statement, expires_at::text
    `;
    return rows[0] ?? null;
  }

  async findOrCreateWalletUser(input: {
    currentUserId: string | null;
    address: string;
    chainId: "143" | "10143";
    userId: string;
    identityId: string;
  }): Promise<string> {
    return this.sql.begin(async (sql) => {
      const providerSubject = `evm:${input.address}`;
      const existing = await sql<{ user_id: string }[]>`
        SELECT user_id FROM user_identities
        WHERE provider = 'wallet'
          AND wallet_namespace = 'evm'
          AND wallet_address = ${input.address}
        LIMIT 1
      `;
      const existingUserId = existing[0]?.user_id;
      if (existingUserId && input.currentUserId && existingUserId !== input.currentUserId) {
        throw new HttpError("identity_already_bound", "identity is already bound to another user", 409);
      }

      const displayName = shortAddress(input.address) ?? "Wallet User";
      const userId = existingUserId ?? input.currentUserId ?? input.userId;
      if (!existingUserId && !input.currentUserId) {
        await sql`
          INSERT INTO users (id, display_name, last_login_at)
          VALUES (${userId}, ${displayName}, now())
        `;
      } else {
        await sql`
          UPDATE users
          SET last_login_at = now(),
              display_name = CASE WHEN display_name = '' THEN ${displayName} ELSE display_name END,
              updated_at = now()
          WHERE id = ${userId}
        `;
      }

      if (existingUserId) {
        await sql`
          UPDATE user_identities
          SET wallet_chain_id = ${input.chainId},
              updated_at = now()
          WHERE provider = 'wallet'
            AND wallet_namespace = 'evm'
            AND wallet_address = ${input.address}
        `;
      } else {
        await sql`
          INSERT INTO user_identities (
            id, user_id, provider, provider_subject, wallet_namespace, wallet_address, wallet_chain_id, display_name
          )
          VALUES (
            ${input.identityId}, ${userId}, 'wallet', ${providerSubject}, 'evm', ${input.address}, ${input.chainId}, ${displayName}
          )
        `;
      }

      return userId;
    });
  }

  async createOauthState(input: {
    id: string;
    state: string;
    codeVerifier: string;
    sessionTokenHash: string;
    stateCookieHash: string;
    expiresAt: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO oauth_states (id, state, code_verifier, session_token_hash, state_cookie_hash, expires_at)
      VALUES (${input.id}, ${input.state}, ${input.codeVerifier}, ${input.sessionTokenHash}, ${input.stateCookieHash}, ${input.expiresAt})
    `;
  }

  async consumeOauthState(state: string): Promise<{
    state: string;
    code_verifier: string;
    session_token_hash: string;
    state_cookie_hash: string;
    expires_at: string;
  } | null> {
    const rows = await this.sql<{
      state: string;
      code_verifier: string;
      session_token_hash: string;
      state_cookie_hash: string;
      expires_at: string;
    }[]>`
      UPDATE oauth_states
      SET consumed_at = now()
      WHERE state = ${state}
        AND consumed_at IS NULL
      RETURNING state, code_verifier, session_token_hash, state_cookie_hash, expires_at::text
    `;
    return rows[0] ?? null;
  }

  async listUserRooms(input: {
    userId: string;
    limit: number;
    cursor?: { updated_at: string; room_id: string };
  }): Promise<UserRoomSummary[]> {
    if (input.cursor) {
      return this.sql<UserRoomSummary[]>`
        SELECT
          r.id AS room_id,
          r.code AS room_code,
          r.status AS room_status,
          g.id AS game_id,
          g.fen,
          g.status,
          g.version,
          g.updated_at::text
        FROM rooms r
        JOIN games g ON g.room_id = r.id
        WHERE r.created_by_user_id = ${input.userId}
          AND (g.updated_at, r.id) < (${input.cursor.updated_at}, ${input.cursor.room_id})
        ORDER BY g.updated_at DESC, r.id DESC
        LIMIT ${input.limit}
      `;
    }

    return this.sql<UserRoomSummary[]>`
      SELECT
        r.id AS room_id,
        r.code AS room_code,
        r.status AS room_status,
        g.id AS game_id,
        g.fen,
        g.status,
        g.version,
        g.updated_at::text
      FROM rooms r
      JOIN games g ON g.room_id = r.id
      WHERE r.created_by_user_id = ${input.userId}
      ORDER BY g.updated_at DESC, r.id DESC
      LIMIT ${input.limit}
    `;
  }
}

function shortAddress(address: string): string | null {
  if (!address) return null;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
