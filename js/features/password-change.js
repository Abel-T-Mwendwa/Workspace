import { client } from "../core/supabase-client.js";
import { endSession } from "../core/session.js";
import { invokeAdmin } from "../services/admin.service.js";
import { bindPasswordHints } from "../ui/password-hints.js";
import { setBusy } from "../ui/busy.js";
import { toast } from "../ui/toast.js";

let session;

export async function requirePasswordChange({ session: currentSession, profile, onSessionRefreshed }) {
  session = currentSession;
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError) {
    if (authError.status === 401 || authError.status === 403) {
      await endSession("expired");
      return;
    }
    throw authError;
  }
  session.user = authData.user;
  const required = profile.password_change_required === true
    || session.user.user_metadata?.password_change_required === true;
  if (!required) return;
  const dismissedKey = `passwordChangeDismissed:${session.user.id}`;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(dismissedKey) === "true";
  } catch (error) {
    console.error("Could not read the temporary password reminder state.", error);
  }
  const dialog = document.createElement("dialog");
  dialog.className = "temporary-password-dialog";
  dialog.innerHTML = `<form id="first-password-form">
    <div class="section-heading"><h2>Change your temporary password</h2><button type="button" class="icon-button" data-password-close aria-label="Close">×</button></div>
    <p class="muted">Choose a new password before continuing. Use at least 8 characters.</p>
    <label>New password<input name="password" type="password" autocomplete="new-password" required><small class="password-hint" data-password-hint>Password must be at least 8 characters.</small></label>
    <label>Confirm new password<input name="confirmation" type="password" autocomplete="new-password" required><small class="password-hint" data-password-hint>Password must be at least 8 characters.</small></label>
    <p class="form-message" data-password-error role="alert"></p>
    <div class="dialog-actions"><button type="button" class="quiet" data-password-dismiss>Not now</button><button class="primary" type="submit">Update password</button></div>
  </form>`;
  let dismissPrompt = () => {};
  dialog.addEventListener("cancel", () => dismissPrompt());
  document.body.append(dialog);
  bindPasswordHints(dialog);
  const banner = document.querySelector("#temporary-password-banner");
  banner?.classList.remove("hidden");
  const changeLink = banner?.querySelector("[data-password-change-now]");
  changeLink?.addEventListener("click", () => {
    if (!dialog.open) dialog.show();
    dialog.querySelector('[name="password"]').focus();
  });
  const prompt = new Promise((resolve) => {
    const dismiss = () => {
      try {
        localStorage.setItem(dismissedKey, "true");
      } catch (error) {
        console.error("Could not save the temporary password reminder state.", error);
      }
      dialog.close();
      changeLink?.focus();
      resolve();
    };
    dismissPrompt = dismiss;
    dialog.querySelector("[data-password-close]").addEventListener("click", dismiss);
    dialog.querySelector("[data-password-dismiss]").addEventListener("click", dismiss);
    dialog.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const errorMessage = dialog.querySelector("[data-password-error]");
      errorMessage.textContent = "";
      if (String(values.get("password")).length < 8) {
        errorMessage.textContent = "Password must be at least 8 characters.";
        return;
      }
      if (values.get("password") !== values.get("confirmation")) {
        errorMessage.textContent = "The passwords do not match.";
        return;
      }
      const button = form.querySelector("[type=submit]");
      setBusy(button, true);
      try {
        await invokeAdmin("self_change_password", { password: values.get("password") });
        const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
        if (refreshError) throw refreshError;
        if (!refreshed.session) throw new Error("Your session expired. Please sign in again.");
        session = refreshed.session;
        onSessionRefreshed(session);
        session.user.user_metadata.password_change_required = false;
        profile.password_change_required = false;
        localStorage.removeItem(dismissedKey);
        banner?.classList.add("hidden");
        dialog.close();
        dialog.remove();
        document.querySelector("#app-header .portal-tab.active")?.focus();
        toast("Password updated.");
        resolve();
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          dialog.close();
          await endSession("expired");
          return;
        }
        errorMessage.textContent = error.message || "Could not update your password.";
        setBusy(button, false);
      }
    });
  });
  if (dismissed) return;
  dialog.show();
  dialog.querySelector('[name="password"]').focus();
  await prompt;
}
