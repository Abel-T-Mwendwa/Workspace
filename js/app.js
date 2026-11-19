import { client } from "./core/supabase-client.js";
import { bindLogoutHandlers, loadAuthContext, watchSignedOut } from "./core/auth.js";
import { monitorSessionExpiry } from "./core/session.js";
import { initPortal } from "./portal.js";
import { initShortcuts } from "./ui/shortcuts.js";
import { configureScrollableTables, initializeScrollableTables } from "./ui/scrollable-table.js";
import { initVehicles } from "./pages/vehicles.js";
import { initRiders, initMyJobs, setRouteActivityRows } from "./features/rider-jobs.js";
import { initUsers } from "./pages/users.js";
import { configureActivityPanel } from "./features/activity-panel.js";
import { toast } from "./ui/toast.js";
import { initStatusBoard } from "./pages/status-board.js";
import { initSales, initDesigner, initAdmin, closeDonePopover, renderSales, renderDesigner, renderAdminRows, cancelArtworkRefresh } from "./features/artwork.js";
import { requirePasswordChange } from "./features/password-change.js";
import { initDeliveries, openDeliveryFromDeepLink, renderDeliveryRows, initializeDeliveryStickyScrollbar, getDeliveryActivityPeriod } from "./features/deliveries.js";
import { configureTableSort } from "./ui/table-sort.js";

const historyDialog = document.querySelector("#history-dialog");
historyDialog?.querySelector("[data-close-dialog]")?.addEventListener("click", () => historyDialog.close());
const page = location.pathname.split("/").pop();

let session;
let profile;
initShortcuts({
  getPage: () => page,
  getProfile: () => profile,
  onEscape: () => closeDonePopover()
});
configureScrollableTables({
  getPage: () => page,
  getProfile: () => profile,
  initializeDeliveryStickyScrollbar
});

configureActivityPanel({
  getDeliveryPeriod: getDeliveryActivityPeriod,
  setRouteRows: setRouteActivityRows
});
configureTableSort({ page, rerender: rerenderSortedPage });

let users = [];

let sessionExpiryTimer = null;

function rerenderSortedPage() {
  if (page === "sales.html") renderSales();
  else if (page === "designer.html") void renderDesigner();
  else if (page === "admin.html") renderAdminRows();
  else if (page === "deliveries.html") renderDeliveryRows();
  else if (page === "production-store.html") renderDeliveryRows();
}

watchSignedOut();

async function bootstrap() {
  initializeScrollableTables();
  try {
    const auth = await loadAuthContext(page);
    if (!auth) return;
    session = auth.session;
    profile = auth.profile;
    sessionExpiryTimer = monitorSessionExpiry({
      getSession: () => session,
      onError: (error) => toast(error.message || "Could not end the expired session.", "error")
    });
    window.addEventListener("pagehide", () => {
      if (sessionExpiryTimer !== null) window.clearInterval(sessionExpiryTimer);
      cancelArtworkRefresh();
      void client.removeAllChannels();
    }, { once: true });
    await initPortal(client, profile, page, toast);
    bindLogoutHandlers();
    await requirePasswordChange({ session, profile,
      onSessionRefreshed: (next) => { session = next; } });
    if (page === "sales.html") await initSales({ profile, page });
    if (page === "designer.html") await initDesigner({ profile, page });
    if (page === "admin.html") await initAdmin({ profile, page });
    if (page === "users.html") await initUsers({ profile });
    if (["deliveries.html", "production-store.html"].includes(page)) await initDeliveries({ profile, page });
    if (page === "riders.html") await initRiders({ profile, page });
    if (page === "route-admin.html") await initRiders({ profile, page });
    if (page === "vehicles.html") await initVehicles({ profile });
    if (page === "my-jobs.html") await initMyJobs({ profile, page });
    if (page === "status-board.html") await initStatusBoard({ profile, page });
    const openId = new URLSearchParams(location.search).get("open");
    if (openId && ["deliveries.html", "production-store.html"].includes(page)) {
      await openDeliveryFromDeepLink(openId);
    } else if (openId) {
      const row = document.querySelector(`[data-entry-id="${CSS.escape(openId)}"]`);
      if (row) {
        row.classList.add("portal-opened-entry");
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  } catch (error) {
    toast(error.message || "Could not load this page.", "error");
  }
}

bootstrap();
