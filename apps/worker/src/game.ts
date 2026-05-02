import { Chess } from "chess.js";
import type { GameStatus } from "@chess-room/shared";
import { HttpError } from "./http";

export function createChess(fen?: string): Chess {
  try {
    return fen ? new Chess(fen) : new Chess();
  } catch {
    throw new HttpError("invalid_fen", "FEN is invalid", 400);
  }
}

export function legalMoves(fen: string): string[] {
  const chess = createChess(fen);
  return chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`);
}

export function applyUci(fen: string, uci: string): { fen: string; san: string; status: GameStatus; turn: "white" | "black" } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    throw new HttpError("invalid_move_format", "move must use UCI format", 400);
  }

  const chess = createChess(fen);
  const moveInput: { from: string; to: string; promotion?: string } = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4)
  };
  if (uci.length === 5) {
    moveInput.promotion = uci.slice(4, 5);
  }
  const move = chess.move(moveInput);

  if (!move) {
    throw new HttpError("invalid_move", "move is not legal in current position", 409);
  }

  return {
    fen: chess.fen(),
    san: move.san,
    status: gameStatus(chess),
    turn: chess.turn() === "w" ? "white" : "black"
  };
}

export function gameStatus(chess: Chess): GameStatus {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDraw()) return "draw";
  return "active";
}

export function turnFromFen(fen: string): "white" | "black" {
  return createChess(fen).turn() === "w" ? "white" : "black";
}
