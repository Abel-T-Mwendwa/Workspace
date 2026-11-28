import { client } from "../core/supabase-client.js";

export async function invokeAdmin(action, payload = {}) {
  const { data, error } = await client.functions.invoke("user-admin", { body: { action, ...payload } });
  if (error) {
    if (error.context && typeof error.context.clone === "function") {
      try {
        const body = await error.context.clone().json();
        if (typeof body?.error === "string") {
          const responseError = new Error(body.error);
          responseError.status = error.context.status;
          throw responseError;
        }
      } catch (responseError) {
        if (!(responseError instanceof SyntaxError)) throw responseError;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
