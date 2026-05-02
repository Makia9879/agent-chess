import { HttpError } from "./http";

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function roomCode(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

export async function sha256(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError("missing_field", `${name} is required`, 400);
  }
  return value.trim();
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError("missing_field", "display_name is required", 400);
  }
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > 64) {
    throw new HttpError("invalid_display_name", "display_name must be 1-64 characters", 400);
  }
  return displayName;
}
