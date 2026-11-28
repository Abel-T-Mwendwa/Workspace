window.APP_CONFIG = {
  supabaseUrl: "https://khfuyuybzcoujdksssrh.supabase.co",
  supabaseAnonKey: "sb_publishable_nU01uqUoxhqzInoPxxhXxw_Z-tGodto"
};

// Load the ignored staging override before the app scripts on local pages.
if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  if (new URLSearchParams(window.location.search).get("workspace-config") === "staging") {
    window.sessionStorage.setItem("workspace-config", "staging");
  }
  if (window.sessionStorage.getItem("workspace-config") === "staging") {
    document.write('<script src="config.staging.local.js"><\/script>');
  }
}

window.createEgressDebugFetch = function createEgressDebugFetch() {
  let enabled = false;
  try {
    enabled = window.localStorage.getItem("debugEgress") === "1";
  } catch (error) {
    console.warn("Could not read the debugEgress setting; Supabase read logging is disabled.", error);
  }
  if (!enabled) return window.fetch;

  const fetchRequest = window.fetch.bind(window);
  return async (input, init) => {
    const response = await fetchRequest(input, init);
    const requestUrl = input instanceof Request
      ? new URL(input.url)
      : new URL(input, window.location.href);
    const method = String(init?.method || input.method || "GET").toUpperCase();
    const tableMatch = requestUrl.pathname.match(/\/rest\/v1\/([^/]+)\/?$/);
    if (!["GET", "HEAD"].includes(method) || !tableMatch || tableMatch[1] === "rpc") return response;

    const table = decodeURIComponent(tableMatch[1]);
    const contentRange = response.headers.get("content-range");
    const totalRows = contentRange?.split("/")[1];
    const readLog = (rows) => console.info("[debugEgress]", {
      table,
      rows,
      totalRows: totalRows && totalRows !== "*" ? Number(totalRows) : null,
      status: response.status,
      timestamp: new Date().toISOString()
    });
    if (method === "HEAD" || !response.ok) {
      readLog(0);
      return response;
    }

    void response.clone().json().then((data) => {
      readLog(Array.isArray(data) ? data.length : data == null ? 0 : 1);
    }).catch((error) => {
      console.warn(`[debugEgress] Could not count rows for ${table}.`, error);
    });
    return response;
  };
};
