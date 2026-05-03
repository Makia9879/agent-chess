import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

type MigrationFile = {
  fileName: string;
  version: number;
  path: string;
};

const migrationFilePattern = /^(\d+)_.*\.sql$/;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(migrationFilePattern);
      if (!match) {
        throw new Error(`Invalid migration file name: ${entry.name}`);
      }

      return {
        fileName: entry.name,
        version: Number(match[1]),
        path: resolve(migrationsDir, entry.name),
      };
    })
    .sort((a, b) => a.version - b.version || a.fileName.localeCompare(b.fileName));

  const seenVersions = new Map<number, string>();
  for (const migration of migrations) {
    const existing = seenVersions.get(migration.version);
    if (existing) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${existing}, ${migration.fileName}`,
      );
    }
    seenVersions.set(migration.version, migration.fileName);
  }

  return migrations;
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const migrations = await loadMigrationFiles();
  if (migrations.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const appliedRows = await sql<{ version: number }[]>`SELECT version FROM schema_migrations`;
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      console.log(`skipping migration ${migration.fileName}`);
      continue;
    }

    const content = await readFile(migration.path, "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(content);
      await transaction`
        INSERT INTO schema_migrations (version, file_name)
        VALUES (${migration.version}, ${migration.fileName})
      `;
    });
    console.log(`applied migration ${migration.fileName}`);
  }

  const encoding = await sql<{ server_encoding: string }[]>`SHOW SERVER_ENCODING`;
  if (encoding[0]?.server_encoding !== "UTF8") {
    throw new Error(`Expected UTF8 database encoding, got ${encoding[0]?.server_encoding ?? "unknown"}`);
  }

  console.log("migration complete; SERVER_ENCODING=UTF8");
} finally {
  await sql.end();
}
