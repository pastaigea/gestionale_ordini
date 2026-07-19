import { HttpError } from "./http.ts";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number };
}

function botToken(): string {
  const value = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!value) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return value;
}

export async function telegramApi<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    },
  );

  const data = await response.json() as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(
      `Telegram ${method} failed: ${data.description ?? response.status}`,
    );
  }
  return data.result;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function telegramAdminIds(): Set<string> {
  const raw = Deno.env.get("TELEGRAM_ADMIN_USER_IDS") ?? "";
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("TELEGRAM_ADMIN_USER_IDS is empty");
  return new Set(ids);
}

export function telegramAdminChatId(): string {
  const value = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")?.trim();
  if (!value || !/^-?\d+$/.test(value)) {
    throw new Error("Invalid TELEGRAM_ADMIN_CHAT_ID");
  }
  return value;
}

export function requireTelegramCallbackData(value: string): {
  action: "accepted" | "rejected";
  token: string;
} {
  const match = /^order:(accept|reject):([A-Za-z0-9_-]{32})$/.exec(value);
  if (!match) throw new HttpError(400, "Invalid callback data");
  return {
    action: match[1] === "accept" ? "accepted" : "rejected",
    token: match[2],
  };
}
