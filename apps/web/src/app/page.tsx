"use client";

import { useEffect, useMemo, useState } from "react";
import type { CreateRoomResponse, CurrentUserView, RoomEvent, RoomState, WalletChainId } from "@chess-room/shared";
import {
  createRoom,
  getMe,
  logout,
  requestWalletChallenge,
  roomEventsUrl,
  submitMove,
  verifyWalletLogin
} from "../lib/api";

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

const monadChains: Record<WalletChainId, { label: string; hex: string; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  "10143": {
    label: "Monad Testnet",
    hex: "0x279f",
    rpcUrls: ["https://testnet-rpc.monad.xyz"],
    blockExplorerUrls: ["https://testnet.monadexplorer.com"]
  },
  "143": {
    label: "Monad Mainnet",
    hex: "0x8f",
    rpcUrls: ["https://rpc.monad.xyz"],
    blockExplorerUrls: ["https://monadexplorer.com"]
  }
};

const workerBaseUrl = process.env.NEXT_PUBLIC_WORKER_BASE_URL ?? "http://localhost:8787";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
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
  const [user, setUser] = useState<CurrentUserView | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [walletChainId, setWalletChainId] = useState<WalletChainId>("10143");
  const [walletNetwork, setWalletNetwork] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void refreshMe();
  }, []);

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

  async function refreshMe() {
    try {
      const response = await getMe();
      setUser(response.user);
    } catch {
      setUser(null);
    }
  }

  async function handleGoogleLogin() {
    setError("");
    setAuthBusy(true);
    window.location.href = `${workerBaseUrl}/api/auth/google/start`;
  }

  async function handleLogout() {
    setError("");
    setAuthBusy(true);
    try {
      await logout();
      setUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "退出登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleWalletLogin() {
    setError("");
    setAuthBusy(true);
    try {
      const provider = getEthereumProvider();
      await ensureWalletChain(provider, walletChainId);
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const walletAddress = accounts[0];
      if (!walletAddress) throw new Error("未获取到钱包地址");
      const challenge = await requestWalletChallenge({ wallet_address: walletAddress, chain_id: walletChainId });
      const signature = (await provider.request({
        method: "personal_sign",
        params: [challenge.message, walletAddress]
      })) as string;
      const response = await verifyWalletLogin({
        wallet_address: walletAddress,
        chain_id: walletChainId,
        nonce: challenge.nonce,
        signature
      });
      setUser(response.user);
      setWalletNetwork(monadChains[walletChainId].label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "钱包登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateRoom() {
    setError("");
    setNotice("");
    try {
      const created = await createRoom(
        fen ? { display_name: displayName, side, fen } : { display_name: displayName, side }
      );
      setRoom(created);
      setParticipantToken(created.participant_token);
      if (!user) {
        setNotice("当前为匿名房间。请保存房间码和参与者 token；登录后创建的房间才会出现在个人房间列表。");
      }
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
        <div className="topbar">
          <h1>Chess Agent Room</h1>
          <div className="userArea">
            {user ? (
              <>
                <img alt="" className="avatar" src={user.avatar_url} />
                <span>{user.display_name}</span>
                <button className="secondaryButton" disabled={authBusy} onClick={handleLogout}>
                  退出
                </button>
              </>
            ) : (
              <>
                <button className="secondaryButton" disabled={authBusy} onClick={handleGoogleLogin}>
                  Google 登录
                </button>
                <select
                  aria-label="钱包网络"
                  value={walletChainId}
                  onChange={(event) => setWalletChainId(event.target.value as WalletChainId)}
                >
                  <option value="10143">Monad Testnet</option>
                  <option value="143">Monad Mainnet</option>
                </select>
                <button className="secondaryButton" disabled={authBusy} onClick={handleWalletLogin}>
                  连接钱包
                </button>
              </>
            )}
          </div>
        </div>
        <p className="networkLabel">{walletNetwork || monadChains[walletChainId].label}</p>
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
          {notice ? <p className="notice">{notice}</p> : null}
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

function getEthereumProvider(): EthereumProvider {
  const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!provider) {
    throw new Error("未检测到 EIP-1193 钱包");
  }
  return provider;
}

async function ensureWalletChain(provider: EthereumProvider, chainId: WalletChainId): Promise<void> {
  const chain = monadChains[chainId];
  const current = await provider.request({ method: "eth_chainId" }).catch(() => "");
  if (current === chain.hex) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hex }] });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chain.hex,
          chainName: chain.label,
          nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
          rpcUrls: chain.rpcUrls,
          blockExplorerUrls: chain.blockExplorerUrls
        }
      ]
    });
  }
}
