"use client";

import { useEffect, useMemo, useState } from "react";
import type { CreateRoomResponse, RoomEvent, RoomState } from "@chess-room/shared";
import { createRoom, roomEventsUrl, submitMove } from "../lib/api";

const pieceSymbols: Record<string, string> = {
  p: "♟",
  r: "♜",
  n: "♞",
  b: "♝",
  q: "♛",
  k: "♚",
  P: "♙",
  R: "♖",
  N: "♘",
  B: "♗",
  Q: "♕",
  K: "♔"
};

function boardFromFen(fen: string): string[][] {
  const placement = fen.split(" ")[0] ?? "";
  return placement.split("/").map((rank) => {
    const squares: string[] = [];
    for (const token of rank) {
      const emptyCount = Number(token);
      if (Number.isInteger(emptyCount) && emptyCount > 0) {
        squares.push(...Array.from({ length: emptyCount }, () => ""));
      } else {
        squares.push(token);
      }
    }
    return squares;
  });
}

function ChessBoard({ fen }: { fen: string }) {
  const board = boardFromFen(fen);
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];

  return (
    <div className="boardWrap" aria-label="当前棋盘">
      <div className="board">
        {board.flatMap((rank, rankIndex) =>
          rank.map((piece, fileIndex) => {
            const isLight = (rankIndex + fileIndex) % 2 === 0;
            const square = `${files[fileIndex]}${8 - rankIndex}`;
            return (
              <div
                className={`square ${isLight ? "light" : "dark"}`}
                key={square}
                title={piece ? `${square}: ${piece}` : square}
              >
                <span className={piece === piece.toUpperCase() ? "whitePiece" : "blackPiece"}>
                  {pieceSymbols[piece]}
                </span>
                <span className="coord">{square}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [displayName, setDisplayName] = useState("agent-white");
  const [side, setSide] = useState<"white" | "black" | "spectator">("white");
  const [fen, setFen] = useState("");
  const [room, setRoom] = useState<CreateRoomResponse | RoomState | null>(null);
  const [participantToken, setParticipantToken] = useState("");
  const [uci, setUci] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!room) return;
    const socket = new WebSocket(roomEventsUrl(room.room_id));
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as RoomEvent;
      if (payload.type === "game.updated") {
        setRoom((current) =>
          current
            ? {
                ...current,
                fen: payload.fen,
                turn: payload.turn,
                status: payload.status,
                version: payload.version,
                legal_moves: payload.legal_moves
              }
            : current
        );
      }
    };
    return () => socket.close();
  }, [room?.room_id]);

  const canMove = useMemo(() => Boolean(room && participantToken && uci), [room, participantToken, uci]);

  async function handleCreateRoom() {
    setError("");
    try {
      const created = await createRoom(
        fen ? { display_name: displayName, side, fen } : { display_name: displayName, side }
      );
      setRoom(created);
      setParticipantToken(created.participant_token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建房间失败");
    }
  }

  async function handleSubmitMove() {
    if (!room) return;
    setError("");
    try {
      setRoom(
        await submitMove(room.room_id, {
          uci,
          participant_token: participantToken,
          expected_version: room.version
        })
      );
      setUci("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交走法失败");
    }
  }

  return (
    <main className="shell">
      <section className="panel">
        <h1>Chess Agent Room</h1>
        <div className="grid">
          <label>
            显示名
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            执棋方
            <select value={side} onChange={(event) => setSide(event.target.value as typeof side)}>
              <option value="white">white</option>
              <option value="black">black</option>
              <option value="spectator">spectator</option>
            </select>
          </label>
        </div>
        <label>
          可选 FEN
          <input value={fen} onChange={(event) => setFen(event.target.value)} />
        </label>
        <button onClick={handleCreateRoom}>创建房间</button>
      </section>

      {room ? (
        <section className="panel">
          <h2>房间 {room.room_code}</h2>
          <dl>
            <dt>Room ID</dt>
            <dd>{room.room_id}</dd>
            <dt>FEN</dt>
            <dd>{room.fen}</dd>
            <dt>行动方</dt>
            <dd>{room.turn}</dd>
            <dt>状态</dt>
            <dd>{room.status}</dd>
            <dt>版本</dt>
            <dd>{room.version}</dd>
          </dl>
          <div className="moveRow">
            <input placeholder="e2e4" value={uci} onChange={(event) => setUci(event.target.value)} />
            <button disabled={!canMove} onClick={handleSubmitMove}>
              提交走法
            </button>
          </div>
          <h3>合法走法</h3>
          <p className="moves">{room.legal_moves.join(" ")}</p>
          <ChessBoard fen={room.fen} />
        </section>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
