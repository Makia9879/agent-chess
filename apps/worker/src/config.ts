export interface Env {
  ROOM_OBJECT: DurableObjectNamespace;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  CORS_ALLOW_ORIGINS?: string;
  ROOM_CODE_LENGTH?: string;
  RUNTIME_CONFIG_TTL_SECONDS?: string;
}

export interface AppConfig {
  databaseUrl: string;
  corsAllowOrigins: string[];
  roomCodeLength: number;
  runtimeConfigTtlSeconds: number;
}

export function loadConfig(env: Env): AppConfig {
  const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or HYPERDRIVE binding is required");
  }

  const roomCodeLength = parseInteger(env.ROOM_CODE_LENGTH ?? "6", "ROOM_CODE_LENGTH");
  const runtimeConfigTtlSeconds = parseInteger(
    env.RUNTIME_CONFIG_TTL_SECONDS ?? "60",
    "RUNTIME_CONFIG_TTL_SECONDS"
  );

  if (roomCodeLength < 4 || roomCodeLength > 16) {
    throw new Error("ROOM_CODE_LENGTH must be between 4 and 16");
  }

  return {
    databaseUrl,
    corsAllowOrigins: (env.CORS_ALLOW_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    roomCodeLength,
    runtimeConfigTtlSeconds
  };
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}
