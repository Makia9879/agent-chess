import { describe, expect, it } from "vitest";
import { applyUci, createChess, legalMoves, turnFromFen } from "./game";

describe("game rules", () => {
  it("creates the initial board and lists legal UCI moves", () => {
    const chess = createChess();
    expect(turnFromFen(chess.fen())).toBe("white");
    expect(legalMoves(chess.fen())).toContain("e2e4");
  });

  it("applies a legal UCI move", () => {
    const chess = createChess();
    const result = applyUci(chess.fen(), "e2e4");
    expect(result.turn).toBe("black");
    expect(result.status).toBe("active");
  });
});
