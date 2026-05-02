import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WorkerClient } from "./client";

const workerBaseUrl = process.env.WORKER_BASE_URL ?? "http://localhost:8787";
const client = new WorkerClient(workerBaseUrl);

const server = new McpServer({
  name: "chess-room-agent",
  version: "0.1.0"
});

server.tool(
  "join_room",
  {
    room_code: z.string(),
    display_name: z.string(),
    side: z.enum(["white", "black"])
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await client.joinRoom(input), null, 2) }]
  })
);

server.tool(
  "get_room_state",
  {
    room_id: z.string()
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await client.getRoomState(input.room_id), null, 2) }]
  })
);

server.tool(
  "get_legal_moves",
  {
    room_id: z.string()
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await client.getLegalMoves(input.room_id), null, 2) }]
  })
);

server.tool(
  "submit_move",
  {
    room_id: z.string(),
    uci: z.string(),
    participant_token: z.string(),
    expected_version: z.number().optional()
  },
  async (input) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await client.submitMove(
            input.room_id,
            input.expected_version === undefined
              ? {
                  uci: input.uci,
                  participant_token: input.participant_token
                }
              : {
                  uci: input.uci,
                  participant_token: input.participant_token,
                  expected_version: input.expected_version
                }
          ),
          null,
          2
        )
      }
    ]
  })
);

await server.connect(new StdioServerTransport());
