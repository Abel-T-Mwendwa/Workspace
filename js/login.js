const client = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});
const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

const routes = {
  salesperson: "home.html", designer: "home.html", admin: "home.html",
  production: "home.html", production_store: "home.html", dispatch: "home.html", route_admin: "home.html", rider: "home.html",
  user: "riders.html"
};
const LOGIN_AT_KEY = "loginAt";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

function bindPasswordHint() {
  const input = form.elements.password;
  const hint = form.querySelector("[data-password-hint]");
  const update = () => {
    hint.textContent = input.value.length >= 8
      ? "Password length is valid."
      : `Password must be at least 8 characters. (${input.value.length}/8)`;
  };
  input.addEventListener("input", update);
  update();
}

function clearLoginAt() {
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch (error) {
    console.error("Could not clear the session timestamp.", error);
  }
}

function sessionIsWithinLimit() {
  try {
    const loginAt = Number(localStorage.getItem(LOGIN_AT_KEY));
    const age = Date.now() - loginAt;
    return Number.isFinite(loginAt) && loginAt > 0 && age >= 0 && age < SESSION_DURATION_MS;
  } catch (error) {
    console.error("Could not read the session timestamp.", error);
    return false;
  }
}

async function routeSession(activeSession = null) {
  let session = activeSession;
  if (!session) {
    const { data, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    session = data.session;
  }
  if (!session) {
    clearLoginAt();
    return;
  }
  if (!sessionIsWithinLimit()) {
    clearLoginAt();
    const { error } = await client.auth.signOut();
    message.textContent = "Your session expired, please log in again.";
    if (error) {
      console.error("Could not sign out the expired session.", error);
      return;
    }
    location.replace("./index.html?session=expired");
    return;
  }
  const { data: profile, error } = await client.from("profiles").select("role,active").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  if (!profile?.active || !routes[profile.role]) {
    clearLoginAt();
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) throw signOutError;
    return;
  }
  location.replace(routes[profile.role]);
}

if (new URLSearchParams(location.search).get("session") === "expired") {
  message.textContent = "Your session expired, please log in again.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  message.textContent = "";
  try {
    const formData = new FormData(form);
    if (String(formData.get("password")).length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }
    const response = await fetch(`${window.APP_CONFIG.supabaseUrl}/functions/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: window.APP_CONFIG.supabaseAnonKey },
      body: JSON.stringify({ username: String(formData.get("username")).trim(), password: formData.get("password") })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to sign in.");
    clearLoginAt();
    const { data: sessionData, error } = await client.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token
    });
    if (error) throw error;
    if (!sessionData.session) throw new Error("The new session could not be restored. Please try again.");
    try {
      localStorage.setItem(LOGIN_AT_KEY, String(Date.now()));
      localStorage.removeItem(`passwordChangeDismissed:${sessionData.session.user.id}`);
    } catch (storageError) {
      console.error("Could not save the session timestamp.", storageError);
      const { error: signOutError } = await client.auth.signOut();
      if (signOutError) console.error("Could not sign out after a session storage failure.", signOutError);
      throw new Error("Your browser could not save the session. Enable local storage and try again.");
    }
    await routeSession(sessionData.session);
  } catch (error) {
    message.textContent = error.message || "Sign-in failed. Check your username and password.";
  } finally {
    button.disabled = false;
  }
});

bindPasswordHint();
routeSession().catch((error) => {
  message.textContent = error.message || "Could not verify your session. Please try again.";
});
