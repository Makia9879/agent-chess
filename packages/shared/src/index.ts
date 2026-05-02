export type ParticipantType = "human" | "agent" | "system";
export type ParticipantSide = "white" | "black" | "spectator";
export type RoomStatus = "waiting" | "active" | "finished" | "closed";
export type GameStatus = "active" | "checkmate" | "stalemate" | "draw" | "resigned";

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface ParticipantView {
  participant_id: string;
  participant_type: ParticipantType;
  display_name: string;
  side: ParticipantSide;
  joined_at: string;
}

export interface MoveView {
  ply: number;
  uci: string;
  san: string;
  actor: ParticipantType;
  participant_id: string | null;
  fen_after: string;
  created_at: string;
}

export interface RoomState {
  room_id: string;
  room_code: string;
  room_status: RoomStatus;
  participants: ParticipantView[];
  game_id: string;
  fen: string;
  turn: "white" | "black";
  status: GameStatus;
  version: number;
  legal_moves: string[];
  moves: MoveView[];
  updated_at: string;
}

export interface CreateRoomRequest {
  fen?: string;
  display_name: string;
  side?: ParticipantSide;
}

export interface CreateRoomResponse extends RoomState {
  participant_id: string;
  participant_token: string;
}

export interface SubmitMoveRequest {
  uci: string;
  participant_token: string;
  expected_version?: number;
}

export type SubmitMoveResponse = RoomState;

export interface LegalMovesResponse {
  room_id: string;
  game_id: string;
  fen: string;
  legal_moves: string[];
}

export interface JoinRoomRequest {
  room_code: string;
  display_name: string;
  side: ParticipantSide;
}

export interface JoinRoomResponse extends RoomState {
  participant_id: string;
  participant_token: string;
}

export interface GameUpdatedEvent {
  type: "game.updated";
  room_id: string;
  game_id: string;
  fen: string;
  last_move: string;
  turn: "white" | "black";
  status: GameStatus;
  version: number;
  legal_moves: string[];
}

export interface ParticipantJoinedEvent {
  type: "room.participant_joined";
  room_id: string;
  participant: ParticipantView;
}

export interface PingEvent {
  type: "ping";
}

export interface WebSocketErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export type RoomEvent = GameUpdatedEvent | ParticipantJoinedEvent | PingEvent | WebSocketErrorEvent;
