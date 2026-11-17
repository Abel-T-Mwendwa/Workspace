import { toast } from "../ui/toast.js";

let visibleRefreshTimer = null;

export function startVisibleRefresh(callback, options = {}) {
  if (visibleRefreshTimer !== null) return visibleRefreshTimer;
  const intervalMs = options.intervalMs ?? 30000;
  const visibilityMinAgeMs = options.visibilityMinAgeMs ?? 0;
  let lastRefreshCompletedAt = Date.now();
  let refreshing = false;
  const lastRefreshAt = options.lastRefreshAt || (() => lastRefreshCompletedAt);
  const refresh = (visibilityReturn = false) => {
    if (document.hidden || refreshing) return;
    if (visibilityReturn && Date.now() - lastRefreshAt() < visibilityMinAgeMs) return;
    refreshing = true;
    Promise.resolve().then(callback).then(() => {
      lastRefreshCompletedAt = Date.now();
    }).catch((error) => {
      toast(error.message || "Could not refresh this list.", "error");
    }).finally(() => {
      refreshing = false;
    });
  };
  const timer = window.setInterval(() => {
    refresh();
  }, intervalMs);
  visibleRefreshTimer = timer;
  const onVisibilityChange = () => {
    if (!document.hidden) refresh(true);
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    if (visibleRefreshTimer === timer) visibleRefreshTimer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }, { once: true });
  return timer;
}
