import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(databaseUrl, { max: 1 });
const migration = await readFile(resolve(process.cwd(), "migrations/0001_init.sql"), "utf8");
await sql.unsafe(migration);
const encoding = await sql<{ server_encoding: string }[]>`SHOW SERVER_ENCODING`;
if (encoding[0]?.server_encoding !== "UTF8") {
  throw new Error(`Expected UTF8 database encoding, got ${encoding[0]?.server_encoding ?? "unknown"}`);
}
await sql.end();
console.log("migration complete; SERVER_ENCODING=UTF8");
