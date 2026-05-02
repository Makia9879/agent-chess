import type { JoinRoomRequest, JoinRoomResponse, RoomState, SubmitMoveRequest } from "@chess-room/shared";

export class WorkerClient {
  constructor(private readonly baseUrl: string) {}

  async joinRoom(input: JoinRoomRequest): Promise<JoinRoomResponse> {
    return this.post(`/api/rooms/by-code/${input.room_code}/join`, input);
  }

  async getRoomState(roomId: string): Promise<RoomState> {
    return this.get(`/api/rooms/${roomId}`);
  }

  async getLegalMoves(roomId: string): Promise<{ room_id: string; game_id: string; legal_moves: string[] }> {
    return this.get(`/api/rooms/${roomId}/legal-moves`);
  }

  async submitMove(roomId: string, input: SubmitMoveRequest): Promise<RoomState> {
    return this.post(`/api/rooms/${roomId}/moves`, input);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    return parseResponse<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return parseResponse<T>(response);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? JSON.stringify(body.error) : response.statusText;
    throw new Error(message);
  }
  return body as T;
}
