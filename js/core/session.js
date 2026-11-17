import { client } from "./supabase-client.js";

export const LOGIN_AT_KEY = "loginAt";
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

let endingSession = false;

function storedLoginAt() {
  try {
    const timestamp = Number(localStorage.getItem(LOGIN_AT_KEY));
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  } catch (error) {
    console.error("Could not read the session timestamp.", error);
    return null;
  }
}

export function clearLoginAt() {
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch (error) {
    console.error("Could not clear the session timestamp.", error);
  }
}

export function sessionIsWithinLimit() {
  const loginAt = storedLoginAt();
  const age = Date.now() - loginAt;
  return loginAt !== null && age >= 0 && age < SESSION_DURATION_MS;
}

export function isEndingSession() {
  return endingSession;
}

export async function endSession(message) {
  endingSession = true;
  clearLoginAt();
  const { error } = await client.auth.signOut();
  location.replace(`./index.html${message ? "?session=expired" : ""}`);
  if (error) throw error;
}

export function monitorSessionExpiry({ getSession, onError }) {
  const checkExpiry = () => {
    if (getSession() && !sessionIsWithinLimit()) {
      void endSession("expired").catch(onError);
    }
  };
  return window.setInterval(checkExpiry, 60 * 1000);
}
