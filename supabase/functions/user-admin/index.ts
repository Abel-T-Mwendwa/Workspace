import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const encryptionKey = Deno.env.get("CREDENTIAL_ENCRYPTION_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey || !encryptionKey || encryptionKey.length < 32) {
    return response({ error: "User administration is not configured." }, 500);
  }

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return response({ error: "Sign in as an administrator." }, 401);
    const token = authHeader.slice("Bearer ".length);
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return response({ error: "Your session is invalid. Sign in again." }, 401);

    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: actor, error: actorError } = await service
      .from("profiles").select("role,active").eq("id", authData.user.id).maybeSingle();
    if (actorError) throw actorError;
    const body = await request.json();
    if (body.action === "self_change_password") {
      const password = typeof body.password === "string" ? body.password : "";
      if (!actor?.active) return response({ error: "This account is inactive." }, 403);
      if (password.length < 8) {
        return response({ error: "Password must contain at least 8 characters." }, 400);
      }
      if (password.length > 1024) return response({ error: "Password is too long." }, 400);
      const { error: updateError } = await service.auth.admin.updateUserById(authData.user.id, {
        password,
        user_metadata: { ...authData.user.user_metadata, password_change_required: false }
      });
      if (updateError) throw updateError;
      const { error: credentialError } = await service.rpc("store_user_credential", {
        p_user_id: authData.user.id, p_password: password, p_key: encryptionKey
      });
      if (credentialError) throw credentialError;
      const { error: profileUpdateError } = await service.from("profiles")
        .update({ password_change_required: false }).eq("id", authData.user.id);
      if (profileUpdateError) throw profileUpdateError;
      return response({ ok: true });
    }
    if (!actor?.active || actor.role !== "admin") return response({ error: "Administrator access is required." }, 403);

    if (body.action === "create_user") {
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const role = body.role;
      const routeAdminAccess = role === "route_admin" || body.route_admin_access === true;
      const productionStoreAccess = role === "production_store" || body.production_store_access === true;
      const riderRequestAccess = role === "user" || body.rider_request_access === true;
      if (password.length < 8) return response({ error: "Password must contain at least 8 characters." }, 400);
      if (password.length > 1024) return response({ error: "Password is too long." }, 400);
      if (!fullName || fullName.length > 160) return response({ error: "Enter a valid full name." }, 400);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
        return response({ error: "Username must contain 1–64 letters, numbers, dots, underscores or hyphens." }, 400);
      }
      if (!["salesperson", "designer", "admin", "production", "production_store", "dispatch", "route_admin", "rider", "user"].includes(role)) {
        return response({ error: "Choose a valid role." }, 400);
      }
      if ((body.route_admin_access !== undefined && typeof body.route_admin_access !== "boolean")
        || (body.production_store_access !== undefined && typeof body.production_store_access !== "boolean")
        || (body.rider_request_access !== undefined && typeof body.rider_request_access !== "boolean")) {
        return response({ error: "Access flags must be true or false." }, 400);
      }
      const email = `${username.toLowerCase()}@promokings.local`;
      const { data: created, error: createError } = await service.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { username, full_name: fullName, role, password_change_required: true }
      });
      if (createError || !created.user) return response({ error: createError?.message || "Could not create user." }, 400);
      const { error: profileError } = await service.from("profiles").insert({
        id: created.user.id, username, full_name: fullName, role, active: true,
        route_admin_access: routeAdminAccess, production_store_access: productionStoreAccess,
        rider_request_access: riderRequestAccess,
        password_change_required: true
      });
      if (profileError) {
        const { error: rollbackError } = await service.auth.admin.deleteUser(created.user.id);
        if (rollbackError) console.error("User creation rollback failed", rollbackError);
        throw profileError;
      }
      const { error: credentialError } = await service.rpc("store_user_credential", {
        p_user_id: created.user.id, p_password: password, p_key: encryptionKey
      });
      if (credentialError) {
        await service.from("profiles").delete().eq("id", created.user.id);
        const { error: rollbackError } = await service.auth.admin.deleteUser(created.user.id);
        if (rollbackError) console.error("Credential rollback failed", rollbackError);
        throw credentialError;
      }
      return response({ user_id: created.user.id });
    }

    if (body.action === "reset_password") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8) return response({ error: "Password must contain at least 8 characters." }, 400);
      if (password.length > 1024) return response({ error: "Password is too long." }, 400);
      if (!userId) {
        return response({ error: "A valid user is required." }, 400);
      }
      const { data: target, error: targetError } = await service.from("profiles").select("id").eq("id", userId).maybeSingle();
      if (targetError) throw targetError;
      if (!target) return response({ error: "User not found." }, 404);
      const { data: authTarget, error: authTargetError } = await service.auth.admin.getUserById(userId);
      if (authTargetError) throw authTargetError;
      if (!authTarget.user) return response({ error: "Auth user not found." }, 404);
      const { error: updateError } = await service.auth.admin.updateUserById(userId, {
        password,
        user_metadata: { ...authTarget.user.user_metadata, password_change_required: true }
      });
      if (updateError) throw updateError;
      const { error: credentialError } = await service.rpc("store_user_credential", {
        p_user_id: userId, p_password: password, p_key: encryptionKey
      });
      if (credentialError) throw credentialError;
      const { error: profileUpdateError } = await service.from("profiles")
        .update({ password_change_required: true }).eq("id", userId);
      if (profileUpdateError) throw profileUpdateError;
      return response({ ok: true });
    }

    if (body.action === "view_password") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!userId) return response({ error: "A user is required." }, 400);
      const { data: target, error: targetError } = await service.from("profiles").select("id").eq("id", userId).maybeSingle();
      if (targetError) throw targetError;
      if (!target) return response({ error: "User not found." }, 404);
      const { data: password, error: passwordError } = await service.rpc("admin_view_password", {
        p_target_user_id: userId, p_actor_id: authData.user.id, p_key: encryptionKey
      });
      if (passwordError) throw passwordError;
      return response({ password });
    }

    if (body.action === "delete_user") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!userId) return response({ error: "A user is required." }, 400);
      const { error: deleteError } = await service.rpc("admin_delete_user", {
        p_target_user_id: userId,
        p_actor_id: authData.user.id
      });
      if (deleteError) throw deleteError;
      return response({ ok: true });
    }

    return response({ error: "Unsupported admin action." }, 400);
  } catch (error) {
    console.error("User admin function failed", error);
    return response({ error: error instanceof Error ? error.message : "User administration failed." }, 500);
  }
});
