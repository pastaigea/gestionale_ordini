import {
  errorResponse,
  handleCorsPreflight,
  HttpError,
  jsonResponse,
  readJson,
  requireMethod,
} from "../_shared/http.ts";
import { requireAdmin } from "../_shared/supabase.ts";

type Payload = {
  dry_run?: boolean;
  invoice: Record<string, unknown>;
};

Deno.serve(async (request) => {
  const cors = handleCorsPreflight(request);
  if (cors) return cors;

  try {
    requireMethod(request, "POST");
    await requireAdmin(request);

    const body = await readJson<Payload>(request, 256 * 1024);
    if (!body.invoice || typeof body.invoice !== "object") {
      throw new HttpError(400, "Missing invoice payload");
    }

    if (body.dry_run) {
      return jsonResponse(request, { dry_run: true, invoice: body.invoice });
    }

    const token = Deno.env.get("FIC_ACCESS_TOKEN");
    const companyId = Deno.env.get("FIC_COMPANY_ID");
    if (!token || !companyId) {
      throw new HttpError(500, "Fatture in Cloud secrets are not configured");
    }

    const response = await fetch(
      `https://api-v2.fattureincloud.it/c/${companyId}/issued_documents`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({ data: body.invoice }),
      },
    );

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return jsonResponse(request, {
        error: "Fatture in Cloud request failed",
        status: response.status,
        result,
      }, 502);
    }

    return jsonResponse(request, { ok: true, result });
  } catch (error) {
    return errorResponse(request, error);
  }
});
