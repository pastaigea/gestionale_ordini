import {
  constantTimeEqual,
  randomToken,
  sha256Hex,
} from "../_shared/crypto.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireMethod,
} from "../_shared/http.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import {
  escapeHtml,
  telegramAdminChatId,
  telegramApi,
  type TelegramMessage,
} from "../_shared/telegram.ts";

interface DispatchRequest {
  outbox_id?: number;
  limit?: number;
}

interface OutboxRow {
  id: number;
  event_type: string;
  aggregate_id: string;
  status: "pending" | "failed" | "processing" | "delivered";
  attempts: number;
  payload: Record<string, unknown>;
}

function requireDispatchSecret(req: Request): void {
  const expected = Deno.env.get("TELEGRAM_DISPATCH_SECRET") ?? "";
  const supplied = req.headers.get("x-igea-dispatch-secret") ?? "";
  if (!expected || !supplied || !constantTimeEqual(expected, supplied)) {
    throw new HttpError(401, "Invalid dispatch credential");
  }
}

function retryAt(attempt: number): string {
  const minutes = Math.min(60, 2 ** Math.min(Math.max(attempt, 1), 6));
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

Deno.serve(async (req) => {
  try {
    requireMethod(req, "POST");
    requireDispatchSecret(req);
    const body = await readJson<DispatchRequest>(req);
    const admin = createAdminClient();
    const limit = Math.min(Math.max(Number(body.limit ?? 5), 1), 10);

    // A worker can be terminated after claiming a row. Make those claims
    // retryable after five minutes instead of leaving them stuck forever.
    const staleLock = new Date(Date.now() - 5 * 60_000).toISOString();
    const { error: staleError } = await admin
      .from("notification_outbox")
      .update({
        status: "failed",
        locked_at: null,
        available_at: new Date().toISOString(),
        last_error: "Stale dispatch lock recovered",
      })
      .eq("status", "processing")
      .eq("event_type", "order.submitted")
      .lt("locked_at", staleLock);
    if (staleError) throw new Error(staleError.message);

    let query = admin
      .from("notification_outbox")
      .select("id,event_type,aggregate_id,status,attempts,payload")
      .in("status", ["pending", "failed"])
      .eq("event_type", "order.submitted")
      .lte("available_at", new Date().toISOString())
      .order("id", { ascending: true })
      .limit(limit);

    if (body.outbox_id !== undefined) {
      if (!Number.isSafeInteger(body.outbox_id) || body.outbox_id <= 0) {
        throw new HttpError(400, "outbox_id is invalid");
      }
      query = query.eq("id", body.outbox_id);
    }

    const { data: candidates, error: candidateError } = await query;
    if (candidateError) throw new Error(candidateError.message);

    const results: Array<{ outbox_id: number; status: string }> = [];
    for (const candidate of (candidates ?? []) as OutboxRow[]) {
      const { data: claimed, error: claimError } = await admin
        .from("notification_outbox")
        .update({
          status: "processing",
          locked_at: new Date().toISOString(),
          attempts: candidate.attempts + 1,
          last_error: null,
        })
        .eq("id", candidate.id)
        .in("status", ["pending", "failed"])
        .select("id")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) continue;

      try {
        const { data: order, error: orderError } = await admin
          .from("orders")
          .select(
            "id,order_number,customer_id,status,requested_delivery_date,gross_total,version,payment_method_snapshot",
          )
          .eq("id", candidate.aggregate_id)
          .single();
        if (orderError || !order) {
          throw new Error(orderError?.message ?? "Order not found");
        }

        if (order.status !== "submitted") {
          const { error } = await admin
            .from("notification_outbox")
            .update({
              status: "delivered",
              processed_at: new Date().toISOString(),
              last_error: "Order no longer submitted; notification skipped",
            })
            .eq("id", candidate.id);
          if (error) throw new Error(error.message);
          results.push({ outbox_id: candidate.id, status: "stale" });
          continue;
        }

        const eventVersion = Number(candidate.payload?.order_version);
        if (
          Number.isSafeInteger(eventVersion) && eventVersion !== order.version
        ) {
          const { error } = await admin
            .from("notification_outbox")
            .update({
              status: "delivered",
              processed_at: new Date().toISOString(),
              last_error:
                "Order version changed; superseded notification skipped",
            })
            .eq("id", candidate.id);
          if (error) throw new Error(error.message);
          results.push({ outbox_id: candidate.id, status: "superseded" });
          continue;
        }

        const { data: customer, error: customerError } = await admin
          .from("customers")
          .select("legal_name")
          .eq("id", order.customer_id)
          .single();
        if (customerError || !customer) {
          throw new Error(customerError?.message ?? "Customer not found");
        }

        const token = randomToken();
        const tokenHash = await sha256Hex(token);
        const chatId = telegramAdminChatId();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString();

        const { error: tokenError } = await admin
          .from("telegram_action_tokens")
          .upsert({
            outbox_id: candidate.id,
            order_id: order.id,
            order_version: order.version,
            token_hash: tokenHash,
            expires_at: expiresAt,
            used_at: null,
            used_action: null,
            chat_id: chatId,
            message_id: null,
          }, { onConflict: "outbox_id" });
        if (tokenError) throw new Error(tokenError.message);

        const amount = Number(order.gross_total).toLocaleString("it-IT", {
          style: "currency",
          currency: "EUR",
        });
        const paymentMethod = order.payment_method_snapshot === "on_delivery"
          ? "Pagamento alla consegna"
          : "Fatturazione a fine mese";
        const text = [
          "<b>Nuovo ordine IGEA</b>",
          `Ordine: <b>#${escapeHtml(order.order_number)}</b>`,
          `Cliente: ${escapeHtml(customer.legal_name)}`,
          `Data richiesta: ${escapeHtml(order.requested_delivery_date)}`,
          `Pagamento: ${escapeHtml(paymentMethod)}`,
          `Totale IVA inclusa: <b>${escapeHtml(amount)}</b>`,
        ].join("\n");

        const appUrl = (Deno.env.get("ADMIN_APP_URL") ??
          "https://pastaigea.github.io/gestionale_ordini/#/admin/ordini")
          .replace(/\/$/, "");
        const appOrderUrl = `${appUrl}${
          appUrl.includes("?") ? "&" : "?"
        }ordine=${order.id}`;

        const message = await telegramApi<TelegramMessage>("sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Accetta", callback_data: `order:accept:${token}` },
                { text: "❌ Rifiuta", callback_data: `order:reject:${token}` },
              ],
              [{ text: "Apri gestionale", url: appOrderUrl }],
            ],
          },
        });

        const { error: tokenUpdateError } = await admin
          .from("telegram_action_tokens")
          .update({ message_id: message.message_id })
          .eq("outbox_id", candidate.id);
        if (tokenUpdateError) throw new Error(tokenUpdateError.message);

        const { error: outboxUpdateError } = await admin
          .from("notification_outbox")
          .update({
            status: "delivered",
            processed_at: new Date().toISOString(),
            locked_at: null,
            last_error: null,
          })
          .eq("id", candidate.id);
        if (outboxUpdateError) throw new Error(outboxUpdateError.message);

        results.push({ outbox_id: candidate.id, status: "delivered" });
      } catch (error) {
        const message = error instanceof Error
          ? error.message.slice(0, 500)
          : "Dispatch failed";
        await admin
          .from("notification_outbox")
          .update({
            status: "failed",
            available_at: retryAt(candidate.attempts + 1),
            locked_at: null,
            last_error: message,
          })
          .eq("id", candidate.id);
        results.push({ outbox_id: candidate.id, status: "failed" });
      }
    }

    return jsonResponse(req, { processed: results.length, results });
  } catch (error) {
    return errorResponse(req, error);
  }
});
