import { constantTimeEqual } from "../_shared/crypto.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireMethod,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import {
  requireTelegramCallbackData,
  telegramAdminChatId,
  telegramAdminIds,
  telegramApi,
} from "../_shared/telegram.ts";

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: {
    message_id: number;
    chat: { id: number };
  };
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

interface ActionResult {
  applied: boolean;
  result_message: string;
  result_order_id: string | null;
  result_status: "accepted" | "rejected" | null;
  result_order_number: number | null;
}

function requireWebhookSecret(req: Request): void {
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  const supplied = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) {
    throw new HttpError(401, "Invalid Telegram webhook credential");
  }
}

async function answerCallback(
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await telegramApi<boolean>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 200),
    show_alert: showAlert,
    cache_time: 0,
  });
}

Deno.serve(async (req) => {
  try {
    requireMethod(req, "POST");
    requireWebhookSecret(req);
    const update = await readJson<TelegramUpdate>(req, 128 * 1024);

    if (!Number.isSafeInteger(update.update_id)) {
      throw new HttpError(400, "Invalid Telegram update");
    }

    const callback = update.callback_query;
    if (!callback) return jsonResponse(req, { ok: true, ignored: true });

    const telegramUserId = String(callback.from?.id ?? "");
    const messageChatId = String(callback.message?.chat?.id ?? "");
    if (
      !telegramAdminIds().has(telegramUserId) ||
      messageChatId !== telegramAdminChatId()
    ) {
      await answerCallback(callback.id, "Utente non autorizzato", true);
      return jsonResponse(req, { ok: true, unauthorized: true });
    }

    if (!callback.data || !callback.message) {
      await answerCallback(callback.id, "Azione non valida", true);
      return jsonResponse(req, { ok: true, invalid: true });
    }

    let parsed: ReturnType<typeof requireTelegramCallbackData>;
    try {
      parsed = requireTelegramCallbackData(callback.data);
    } catch {
      await answerCallback(callback.id, "Azione non riconosciuta", true);
      return jsonResponse(req, { ok: true, invalid: true });
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("apply_telegram_order_action", {
      p_update_id: update.update_id,
      p_token: parsed.token,
      p_action: parsed.action,
      p_telegram_user_id: callback.from.id,
    });
    if (error) throw new Error(error.message);

    const result = (Array.isArray(data) ? data[0] : data) as
      | ActionResult
      | null;
    if (!result) throw new Error("Telegram action returned no result");

    if (!result.applied) {
      await answerCallback(callback.id, result.result_message, true);
      return jsonResponse(req, { ok: true, applied: false });
    }

    const statusLabel = result.result_status === "accepted"
      ? "accettato"
      : "rifiutato";
    await answerCallback(
      callback.id,
      `Ordine #${result.result_order_number} ${statusLabel}`,
    );

    // Removing the keyboard prevents another administrator from clicking a stale action.
    try {
      await telegramApi<unknown>("editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      // The database transition is authoritative; a Telegram UI edit failure is non-fatal.
      console.error(
        "Telegram action applied but reply markup could not be removed",
      );
    }

    return jsonResponse(req, {
      ok: true,
      applied: true,
      order_id: result.result_order_id,
      status: result.result_status,
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});
