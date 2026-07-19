import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2.52.0";
import { HttpError } from "./http.ts";

export interface AuthenticatedContext {
  user: User;
  profile: {
    user_id: string;
    display_name: string;
    role: "client" | "admin";
    active: boolean;
  };
  client: SupabaseClient;
}

function requiredEnv(name: string, fallbacks: string[] = []): string {
  for (const candidate of [name, ...fallbacks]) {
    const value = Deno.env.get(candidate);
    if (value) return value;
  }
  throw new Error(`Missing environment variable: ${name}`);
}

export function createAdminClient(): SupabaseClient {
  const url = requiredEnv("SUPABASE_URL");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY", [
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function createPublicClient(): SupabaseClient {
  const url = requiredEnv("SUPABASE_URL");
  const publishableKey = requiredEnv("SUPABASE_PUBLISHABLE_KEY", [
    "SUPABASE_ANON_KEY",
  ]);

  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export async function requireAuthenticated(
  req: Request,
): Promise<AuthenticatedContext> {
  const authorization = req.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Authentication required");
  }

  const token = authorization.slice(7).trim();
  if (!token) throw new HttpError(401, "Authentication required");

  const url = requiredEnv("SUPABASE_URL");
  const publishableKey = requiredEnv("SUPABASE_PUBLISHABLE_KEY", [
    "SUPABASE_ANON_KEY",
  ]);
  const client = createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) throw new HttpError(401, "Invalid session");

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("user_id,display_name,role,active")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile || !profile.active) {
    throw new HttpError(403, "Account is not active");
  }

  return {
    user: userData.user,
    profile: profile as AuthenticatedContext["profile"],
    client,
  };
}

export async function requireAdmin(
  req: Request,
): Promise<AuthenticatedContext> {
  const context = await requireAuthenticated(req);
  if (context.profile.role !== "admin") {
    throw new HttpError(403, "Administrator access required");
  }
  return context;
}
