import {
  errorResponse,
  handleCorsPreflight,
  HttpError,
  jsonResponse,
  readJson,
  requireMethod,
} from "../_shared/http.ts";
import {
  createAdminClient,
  createPublicClient,
  requireAdmin,
} from "../_shared/supabase.ts";

type AdminUserAction =
  | "invite"
  | "create"
  | "send_reset"
  | "set_password"
  | "update_email"
  | "disable"
  | "enable";

interface AdminUserRequest {
  action: AdminUserAction;
  user_id?: string;
  email?: string;
  password?: string;
  display_name?: string;
  existing_customer_id?: string | null;
  customer?: Record<string, unknown>;
  redirect_to?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredText(value: unknown, label: string, maxLength = 320): string {
  if (
    typeof value !== "string" || !value.trim() ||
    value.trim().length > maxLength
  ) {
    throw new HttpError(400, `${label} is invalid`);
  }
  return value.trim();
}

function validEmail(value: unknown): string {
  const email = requiredText(value, "Email").toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "Email is invalid");
  return email;
}

function validUserId(value: unknown): string {
  const userId = requiredText(value, "User id", 64);
  if (!UUID_PATTERN.test(userId)) {
    throw new HttpError(400, "User id is invalid");
  }
  return userId;
}

function validPassword(value: unknown): string {
  const password = requiredText(value, "Password", 256);
  if (password.length < 12) {
    throw new HttpError(400, "Password must be at least 12 characters");
  }
  return password;
}

async function writeAudit(
  actorUserId: string,
  action: string,
  targetUserId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("admin_audit_log").insert({
    actor_user_id: actorUserId,
    action,
    target_user_id: targetUserId,
    details,
  });
  if (error) throw new Error(`Audit write failed: ${error.message}`);
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    requireMethod(req, "POST");
    const context = await requireAdmin(req);
    const body = await readJson<AdminUserRequest>(req);
    const admin = createAdminClient();

    if (!body.action) throw new HttpError(400, "Action is required");

    if (body.action === "invite" || body.action === "create") {
      const email = validEmail(body.email);
      const displayName = requiredText(body.display_name, "Display name", 160);
      const existingCustomerId = body.existing_customer_id
        ? validUserId(body.existing_customer_id)
        : null;

      if (
        !existingCustomerId &&
        (!body.customer || typeof body.customer !== "object")
      ) {
        throw new HttpError(
          400,
          "Customer data or existing_customer_id is required",
        );
      }

      let createdUserId: string | null = null;
      try {
        if (body.action === "invite") {
          const redirectTo =
            Deno.env.get("PASSWORD_REDIRECT_URL") ??
            "https://pastaigea.github.io/gestionale_ordini/";
          const { data, error } = await admin.auth.admin.inviteUserByEmail(
            email,
            {
              data: { display_name: displayName },
              redirectTo,
            },
          );
          if (error || !data.user) {
            throw new HttpError(400, error?.message ?? "Unable to invite user");
          }
          createdUserId = data.user.id;
        } else {
          const password = validPassword(body.password);
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { display_name: displayName },
          });
          if (error || !data.user) {
            throw new HttpError(400, error?.message ?? "Unable to create user");
          }
          createdUserId = data.user.id;
        }

        const { data: customerId, error: registerError } = await admin.rpc(
          "admin_register_client_identity",
          {
            p_user_id: createdUserId,
            p_email: email,
            p_display_name: displayName,
            p_customer: body.customer ?? {},
            p_existing_customer_id: existingCustomerId,
            p_actor_user_id: context.user.id,
          },
        );
        if (registerError) throw new Error(registerError.message);

        return jsonResponse(req, {
          user_id: createdUserId,
          customer_id: customerId,
          invited: body.action === "invite",
        }, 201);
      } catch (error) {
        if (createdUserId) {
          const { error: cleanupError } = await admin.auth.admin.deleteUser(
            createdUserId,
          );
          if (cleanupError) {
            console.error("Unable to roll back Auth user creation");
          }
        }
        throw error;
      }
    }

    if (body.action === "send_reset") {
      const email = validEmail(body.email);
      const redirectTo =
        Deno.env.get("PASSWORD_REDIRECT_URL") ??
        "https://pastaigea.github.io/gestionale_ordini/";
      const publicClient = createPublicClient();
      const { error } = await publicClient.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (error) throw new HttpError(400, error.message);

      await writeAudit(
        context.user.id,
        "client.password_reset_requested",
        null,
        {
          email,
        },
      );
      return jsonResponse(req, { ok: true });
    }

    if (body.action === "set_password") {
      const userId = validUserId(body.user_id);
      const password = validPassword(body.password);
      const { data: targetProfile, error: targetError } = await admin
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (targetError || !targetProfile || targetProfile.role !== "client") {
        throw new HttpError(400, "Client profile not found");
      }
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password,
      });
      if (error) throw new HttpError(400, error.message);

      await writeAudit(context.user.id, "client.password_set_by_admin", userId);
      return jsonResponse(req, { ok: true });
    }

    if (body.action === "update_email") {
      const userId = validUserId(body.user_id);
      const email = validEmail(body.email);
      const { data: previousData, error: previousError } = await admin.auth
        .admin.getUserById(userId);
      if (previousError || !previousData.user || !previousData.user.email) {
        throw new HttpError(400, "Client Auth user not found");
      }
      const previousEmail = previousData.user.email;

      const { error: authError } = await admin.auth.admin.updateUserById(
        userId,
        {
          email,
          email_confirm: true,
        },
      );
      if (authError) throw new HttpError(400, authError.message);

      const { data: customerId, error: customerError } = await admin.rpc(
        "admin_update_client_email",
        {
          p_user_id: userId,
          p_email: email,
          p_actor_user_id: context.user.id,
        },
      );
      if (customerError) {
        const { error: rollbackError } = await admin.auth.admin.updateUserById(
          userId,
          {
            email: previousEmail,
            email_confirm: true,
          },
        );
        if (rollbackError) {
          console.error("Unable to roll back Auth email change");
        }
        throw new Error(customerError.message);
      }

      return jsonResponse(req, {
        ok: true,
        user_id: userId,
        customer_id: customerId,
      });
    }

    if (body.action === "disable" || body.action === "enable") {
      const userId = validUserId(body.user_id);
      if (userId === context.user.id) {
        throw new HttpError(400, "An administrator cannot disable itself");
      }
      const active = body.action === "enable";

      const { error: authError } = await admin.auth.admin.updateUserById(
        userId,
        {
          ban_duration: active ? "none" : "876000h",
        },
      );
      if (authError) throw new HttpError(400, authError.message);

      const { error: profileError } = await admin.rpc(
        "admin_set_profile_active",
        {
          p_user_id: userId,
          p_active: active,
          p_actor_user_id: context.user.id,
        },
      );
      if (profileError) {
        await admin.auth.admin.updateUserById(userId, {
          ban_duration: active ? "876000h" : "none",
        });
        throw new Error(profileError.message);
      }

      return jsonResponse(req, { ok: true, active });
    }

    throw new HttpError(400, "Unsupported action");
  } catch (error) {
    return errorResponse(req, error);
  }
});
