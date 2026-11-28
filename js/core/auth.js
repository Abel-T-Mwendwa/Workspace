import { client } from "./supabase-client.js";
import { endSession, isEndingSession, sessionIsWithinLimit } from "./session.js";
import { toast } from "../ui/toast.js";
import { isPortalPageAllowed, homePageForRole } from "../portal.js";

export function watchSignedOut() {
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && !isEndingSession()) location.replace("./index.html");
  });
}

export function bindLogoutHandlers() {
  document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await endSession();
    } catch (error) {
      toast(error.message || "Could not sign out.", "error");
      button.disabled = false;
    }
  }));
}

export async function loadAuthContext(page) {
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (page === "my-jobs.html") console.log("[TEMP-DEBUG] auth ready", Boolean(session), session?.user?.id); // TEMP-DEBUG
  if (!session) {
    location.replace("./index.html");
    return null;
  }
  if (!sessionIsWithinLimit()) {
    await endSession("expired");
    return null;
  }
  const { data: profile, error } = await client.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  if (!profile?.active) {
    await endSession();
    return null;
  }
  if (page === "my-jobs.html") console.log("[TEMP-DEBUG] rider id resolved", profile.id); // TEMP-DEBUG
  if (profile.role === "admin" && page === "my-jobs.html") {
    location.replace("./home.html");
    return null;
  }
  if (!isPortalPageAllowed(page, profile)) {
    location.replace(`./${profile.role === "user" ? "riders.html" : homePageForRole()}`);
    return null;
  }
  return { session, profile };
}
