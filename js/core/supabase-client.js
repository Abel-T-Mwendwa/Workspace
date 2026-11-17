export const client = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey, {
  ...(typeof window.createEgressDebugFetch === "function"
    ? { global: { fetch: window.createEgressDebugFetch() } }
    : {}),
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});
