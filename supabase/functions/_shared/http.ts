const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://pastaigea.github.io",
];

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function allowedOrigins(): Set<string> {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin")?.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (origin && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;

  const origin = req.headers.get("origin")?.replace(/\/$/, "");
  if (origin && !allowedOrigins().has(origin)) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readJson<T>(
  req: Request,
  maxBytes = 64 * 1024,
): Promise<T> {
  const body = await req.text();
  if (body.length > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function errorResponse(req: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(req, { error: error.message }, error.status);
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("Edge Function error:", message);
  return jsonResponse(req, { error: "Internal server error" }, 500);
}

export function requireMethod(req: Request, method: string): void {
  if (req.method !== method) throw new HttpError(405, "Method not allowed");
}
