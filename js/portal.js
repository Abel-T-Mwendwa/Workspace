const NAV = {
  salesperson: [
    ["Home", "home.html"], ["Artworks", "sales.html"], ["Deliveries", "deliveries.html"], ["Riders", "riders.html"]
  ],
  designer: [["Home", "home.html"], ["Artworks", "designer.html"]],
  production: [["Home", "home.html"], ["Deliveries", "deliveries.html"]],
  production_store: [["Home", "home.html"], ["Production store", "production-store.html"]],
  dispatch: [["Home", "home.html"], ["Deliveries", "deliveries.html"], ["Vehicles", "vehicles.html"]],
  route_admin: [["Home", "home.html"], ["Route admin", "route-admin.html"]],
  user: [["Riders", "riders.html"]],
  rider: [["Home", "home.html"], ["My jobs", "my-jobs.html"]],
  admin: [
    ["Home", "home.html"], ["Artworks", "admin.html"], ["Users", "users.html"],
    ["Deliveries", "deliveries.html"], ["Route admin", "route-admin.html"], ["Vehicles", "vehicles.html"]
  ]
};

const HOME_CATEGORIES = {
  salesperson: ["Artworks", "Deliveries", "Riders"],
  designer: ["Artworks"],
  production: ["Deliveries"],
  production_store: ["Deliveries"],
  dispatch: ["Deliveries", "Vehicles"],
  route_admin: ["Riders"],
  rider: ["My jobs"],
  admin: ["Artworks", "Deliveries", "Riders", "Vehicles"]
};

const HOME_CONFIG = {
  Artworks: { table: "artwork_requests", select: "id,ref_no,client_name,status,created_at,date_needed,done_at", time: "done_at", href: "artwork" },
  Deliveries: { table: "deliveries", select: "id,ref_no,client_name,production_status,dispatch_status,created_at,delivery_date,delivered_at,items", time: "delivered_at", href: "delivery" },
  Riders: { table: "rider_jobs", select: "id,ref_no,client_name,status,job_type,address,created_at,scheduled_date,finished_at,assigned_rider", time: "finished_at", href: "rider" },
  "My jobs": { table: "rider_jobs", select: "id,ref_no,client_name,status,job_type,address,created_at,scheduled_date,finished_at,assigned_rider", time: "finished_at", href: "rider" },
  Vehicles: { table: "vehicles", select: "id,registration_number,description,active,created_at", time: "created_at", href: "vehicle" }
};

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi"
  }).format(new Date(value));
}

export function hasRouteAdminAccess(profile) {
  return profile.role === "admin" || profile.role === "route_admin" || profile.route_admin_access === true;
}

export function hasProductionStoreAccess(profile) {
  return profile.role === "production_store" || profile.production_store_access === true;
}

export function hasRiderRequestAccess(profile) {
  return profile.role === "user" || profile.role === "salesperson" || profile.rider_request_access === true;
}

function pageAllowed(page, profile) {
  const { role } = profile;
  if (role === "user") return page === "riders.html";
  if (page === "production-store.html") return hasProductionStoreAccess(profile);
  if (role === "admin") return page !== "my-jobs.html";
  const rolePages = {
    salesperson: ["home.html", "sales.html", "deliveries.html", "riders.html"],
    designer: ["home.html", "designer.html"],
    production: ["home.html", "deliveries.html"],
    production_store: ["home.html"],
    dispatch: ["home.html", "deliveries.html", "vehicles.html"],
    rider: ["home.html", "my-jobs.html"],
    route_admin: ["home.html", "route-admin.html"]
  };
  if (page === "users.html") return false;
  return rolePages[role]?.includes(page) === true
    || (page === "riders.html" && hasRouteAdminAccess(profile))
    || (page === "riders.html" && hasRiderRequestAccess(profile))
    || (page === "route-admin.html" && hasRouteAdminAccess(profile));
}

export function isPortalPageAllowed(page, profile) {
  return pageAllowed(page, profile);
}

export function homePageForRole() {
  return "home.html";
}

export async function initPortal(client, profile, page, toast) {
  const header = document.querySelector("#app-header");
  if (!header) return;

  const tabs = [...(NAV[profile.role] || [])];
  if (hasProductionStoreAccess(profile) && !tabs.some(([, href]) => href === "production-store.html")) {
    tabs.push(["Production store", "production-store.html"]);
  }
  if (hasRiderRequestAccess(profile) && !tabs.some(([, href]) => href === "riders.html")) {
    tabs.push(["Riders", "riders.html"]);
  }
  if (profile.role === "salesperson" && hasRouteAdminAccess(profile)
    && !tabs.some(([, href]) => href === "route-admin.html")) {
    tabs.push(["Route admin", "route-admin.html"]);
  }
  if (profile.role === "admin" && !tabs.some(([, href]) => href === "route-admin.html")) {
    tabs.push(["Route admin", "route-admin.html"]);
  }
  header.innerHTML = `<a class="portal-logo" href="home.html" aria-label="Promo Kings home"><img src="images/promo-kings-logo.svg" alt="Promo Kings logo"></a>
    <button class="mobile-menu-button" type="button" data-menu-toggle aria-expanded="false" aria-controls="portal-tabs"><span aria-hidden="true">☰</span><span class="menu-button-label">Menu</span></button>
    <nav class="portal-tabs" aria-label="Main navigation">${tabs.map(([label, href]) =>
      `<a class="portal-tab${href === page ? " active" : ""}" href="${href}"${href === page ? ' aria-current="page"' : ""}>${escape(label)}</a>`
    ).join("")}</nav>
    <div class="top-actions"><details class="shortcut-help"><summary aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</summary><div><strong>Keyboard shortcuts</strong><span><kbd>Enter</kbd> Save the open form or editor</span><span><kbd>+</kbd> Add a line or request</span><span><kbd>−</kbd> Remove the focused line or item</span><span><kbd>Esc</kbd> Close a popup</span></div></details>${profile.role === "designer" ? '<button id="change-bell" class="quiet" aria-label="Open change requests">Changes <b id="change-count">0</b></button><button id="assignment-bell" class="quiet" aria-label="Open new assignments">New assignments <b id="assignment-count">0</b></button>' : ""}
      <button type="button" id="portal-notification-button" class="quiet" aria-label="Notifications"><span class="notification-label">Notifications</span><b id="portal-notification-count">0</b></button>
      <span id="current-user">${escape(profile.full_name)}</span><button type="button" class="quiet" data-logout aria-label="Log out">Log out</button></div>`;
  header.insertAdjacentHTML("afterend", '<div id="temporary-password-banner" class="notice hidden">Please change your temporary password <button type="button" class="quiet" data-password-change-now>Change now</button></div>');
  ensurePortalDialogs();

  const toggle = header.querySelector("[data-menu-toggle]");
  toggle?.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    header.classList.toggle("menu-open", !expanded);
  });

  if (page === "home.html") await renderHome(client, profile, toast);
  if (page === "home.html") setupHomeLive(client, profile, toast);
  await setupNotifications(client, profile, toast);
}

function setupHomeLive(client, profile, toast) {
  const categories = [...(HOME_CATEGORIES[profile.role] || [])];
  if (hasRouteAdminAccess(profile) && !categories.includes("Riders")) categories.push("Riders");
  const tables = [...new Set(categories.map((category) => HOME_CONFIG[category].table))];
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || document.hidden) return;
    refreshing = true;
    const scrollY = window.scrollY;
    const existingCards = [...document.querySelectorAll(".home-card[data-entry-id]")];
    const previousIds = new Set(existingCards.map((card) => card.dataset.entryId));
    const filters = new Map([...document.querySelectorAll(".home-row")].map((section) => [
      section.querySelector("h2")?.textContent,
      {
        status: section.querySelector("[data-home-status]")?.value || "",
        date: section.querySelector("[data-home-date]")?.value || "all"
      }
    ]));
    try {
      await renderHome(client, profile, toast);
      document.querySelectorAll(".home-row").forEach((section) => {
        const saved = filters.get(section.querySelector("h2")?.textContent);
        if (!saved) return;
        section.querySelector("[data-home-status]").value = saved.status;
        section.querySelector("[data-home-date]").value = saved.date;
        section.querySelector("[data-home-status]").dispatchEvent(new Event("change"));
      });
      if (existingCards.length) {
        document.querySelectorAll(".home-card[data-entry-id]").forEach((card) => {
          if (!previousIds.has(card.dataset.entryId)) card.classList.add("portal-new-row");
        });
      }
      window.scrollTo({ top: scrollY });
    } catch (error) {
      toast(error.message || "Could not refresh Home.", "error");
    } finally {
      refreshing = false;
    }
  };
  const channels = tables.map((table) => client.channel(`home-${profile.id}-${table}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, () => { void refresh(); })
    .subscribe());
  const timer = window.setInterval(() => { void refresh(); }, 25000);
  const onVisibilityChange = () => { if (!document.hidden) void refresh(); };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    channels.forEach((channel) => { void client.removeChannel(channel); });
  }, { once: true });
}

function ensurePortalDialogs() {
  if (!document.querySelector("#portal-notifications-dialog")) {
    const dialog = document.createElement("dialog");
    dialog.id = "portal-notifications-dialog";
    dialog.innerHTML = `<div class="section-heading"><h2>Notifications</h2><button type="button" class="icon-button" data-close-notifications aria-label="Close">×</button></div><div id="portal-notification-list"></div>`;
    document.body.append(dialog);
  }
  if (!document.querySelector("#rider-assignment-dialog")) {
    const dialog = document.createElement("dialog");
    dialog.id = "rider-assignment-dialog";
    dialog.className = "rider-assignment-dialog";
    dialog.innerHTML = `<div class="section-heading"><h2>New job request</h2><button type="button" class="icon-button" data-assignment-close aria-label="Close">×</button></div><p></p><div class="dialog-actions"><button type="button" class="primary" data-assignment-ok>OK</button></div>`;
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog.dataset.blocking === "true") event.preventDefault();
    });
    document.body.append(dialog);
  }
}

async function queryHomeRows(client, profile, category) {
  const config = HOME_CONFIG[category];
  const table = category === "Deliveries" && ["production", "dispatch", "production_store"].includes(profile.role)
    ? "deliveries_role_safe" : config.table;
  let query = client.from(table).select(config.select);
  if (category === "My jobs") query = query.eq("assigned_rider", profile.id);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(20);
  if (error) throw error;
  return data || [];
}

function homeStatus(category, row) {
  if (category === "Artworks") return row.status;
  if (category === "Deliveries") return `${row.production_status} · ${row.dispatch_status}`;
  if (category === "Vehicles") return row.active ? "Active" : "Inactive";
  return row.status;
}

function homeSummary(category, row) {
  if (category === "Artworks") return `Needed ${row.date_needed || "—"}`;
  if (category === "Deliveries") {
    const itemCount = Array.isArray(row.items) ? row.items.length : 0;
    return `${itemCount} item line${itemCount === 1 ? "" : "s"} · ${row.delivery_date || "—"}`;
  }
  if (category === "Riders" || category === "My jobs") return `${row.job_type} · ${row.address}`;
  return row.description;
}

function homeDateMatch(row, category, filter) {
  if (filter === "all") return true;
  const stamp = row[HOME_CONFIG[category].time];
  if (!stamp) return false;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date(stamp));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
  const offset = (days) => {
    const [year, month, day] = today.split("-").map(Number);
    const value = new Date(Date.UTC(year, month - 1, day - days, 12));
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(value);
  };
  if (filter === "today") return date === today;
  if (filter === "yesterday") return date === offset(1);
  return date >= offset(6) && date <= today;
}

function homeTabHref(category, profile) {
  if (category === "Artworks") return profile.role === "designer" ? "designer.html" : profile.role === "admin" ? "admin.html" : "sales.html";
  if (category === "Deliveries") return profile.role === "production_store" ? "production-store.html" : "deliveries.html";
  if (category === "Vehicles") return "vehicles.html";
  if (category === "My jobs") return "my-jobs.html";
  if (category === "Riders" && ["admin", "route_admin"].includes(profile.role)) return "route-admin.html";
  return "riders.html";
}

function renderHomeRow(section, category, rows, profile) {
  const statusOptions = [...new Set(rows.map((row) => homeStatus(category, row)).filter(Boolean))];
  const clickHref = homeTabHref(category, profile);
  section.innerHTML = `<div class="home-row-heading"><div><h2>${escape(category)}</h2><a href="${clickHref}">See more</a></div>
    <div class="home-filters"><label>Status<select data-home-status><option value="">All statuses</option>${statusOptions.map((status) => `<option value="${escape(status)}">${escape(status)}</option>`).join("")}</select></label>
    <label>Completed<select data-home-date><option value="all">All</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">Last 7 days</option></select></label></div></div>
    <div class="home-card-strip" tabindex="0" aria-label="${escape(category)}"></div>
    <p class="empty-state hidden" data-home-empty>No entries match these filters.</p>`;
  const strip = section.querySelector(".home-card-strip");
  const render = () => {
    const status = section.querySelector("[data-home-status]").value;
    const date = section.querySelector("[data-home-date]").value;
    const filtered = rows.filter((row) => (!status || homeStatus(category, row) === status)
      && homeDateMatch(row, category, date));
    strip.innerHTML = filtered.map((row) => {
      const title = category === "Vehicles" ? row.registration_number : row.client_name;
      const reference = row.ref_no || "—";
      return `<a class="home-card" data-entry-id="${escape(row.id)}" href="${clickHref}?open=${encodeURIComponent(row.id)}">
        <span class="home-card-ref">${escape(reference)}</span><strong>${escape(title)}</strong>
        <span>${escape(homeStatus(category, row))}</span><small>${escape(homeSummary(category, row))}</small>
        <time>${escape(formatTime(row.created_at))}</time></a>`;
    }).join("");
    section.querySelector("[data-home-empty]").classList.toggle("hidden", filtered.length > 0);
  };
  section.querySelector("[data-home-status]").addEventListener("change", render);
  section.querySelector("[data-home-date]").addEventListener("change", render);
  render();
}

async function renderHome(client, profile, toast) {
  const root = document.querySelector("#home-rows");
  root.replaceChildren();
  const categories = [...(HOME_CATEGORIES[profile.role] || [])];
  if (hasRouteAdminAccess(profile) && !categories.includes("Riders")) categories.push("Riders");
  for (const category of categories) {
    const section = document.createElement("section");
    section.className = "home-row";
    section.innerHTML = `<p class="muted">Loading ${escape(category)}…</p>`;
    root.append(section);
    try {
      renderHomeRow(section, category, await queryHomeRows(client, profile, category), profile);
    } catch (error) {
      section.innerHTML = `<p class="form-message">${escape(error.message || `Could not load ${category}.`)}</p>`;
      toast(error.message || `Could not load ${category}.`, "error");
    }
  }
}

async function setupNotifications(client, profile, toast) {
  const button = document.querySelector("#portal-notification-button");
  const dialog = document.querySelector("#portal-notifications-dialog");
  const count = document.querySelector("#portal-notification-count");
  const list = document.querySelector("#portal-notification-list");
  let notifications = [];
  let unreadCount = 0;
  let blocking = false;
  let timer = null;
  let channel = null;
  let firstRefresh = true;
  let assignmentTimer = null;
  const pendingAssignments = new Map();
  const shownAssignments = new Set();
  if (!button || !dialog || !count || !list) return;

  async function refresh() {
    const [notificationsResult, countResult] = await Promise.all([
      client.from("portal_notifications")
        .select("id,notification_type,related_id,created_at,read_at")
        .order("created_at", { ascending: false }).limit(50),
      client.from("portal_notifications").select("id", { count: "exact", head: true }).is("read_at", null)
    ]);
    if (notificationsResult.error || countResult.error) {
      const error = notificationsResult.error || countResult.error;
      toast(error.message || "Could not load notifications.", "error");
      return;
    }
    const previousIds = new Set(notifications.map((item) => item.id));
    notifications = notificationsResult.data || [];
    const unread = notifications.filter((item) => !item.read_at);
    unreadCount = countResult.count || 0;
    count.textContent = String(unreadCount);
    if (!firstRefresh && profile.role !== "rider") {
      unread.filter((item) => !previousIds.has(item.id)).forEach((item) => {
        const label = notificationLabel(item.notification_type);
        toast(label, "success");
      });
    }
    firstRefresh = false;
    if (profile.role === "rider") {
      unread.filter((item) => item.notification_type === "rider_job_assigned").forEach((item) => {
        if (!shownAssignments.has(item.id)) {
          shownAssignments.add(item.id);
          pendingAssignments.set(item.id, item);
        }
      });
      if (pendingAssignments.size) {
        if (blocking) updateAssignmentDialog(pendingAssignments.size);
        else if (assignmentTimer === null) {
          assignmentTimer = window.setTimeout(() => {
            assignmentTimer = null;
            if (pendingAssignments.size && !blocking) void showAssignment();
          }, 500);
        }
      }
    }
    document.dispatchEvent(new CustomEvent("portal:notifications", { detail: notifications }));
    if (dialog.open) renderNotifications();
  }

  async function markRead(notification) {
    if (notification.read_at) return;
    const { error } = await client.from("portal_notifications")
      .update({ read_at: new Date().toISOString() }).eq("id", notification.id).is("read_at", null);
    if (error) throw error;
    notification.read_at = new Date().toISOString();
    unreadCount = Math.max(0, unreadCount - 1);
    count.textContent = String(unreadCount);
  }

  async function markRelatedRead(relatedId) {
    const matching = notifications.filter((item) => item.related_id === relatedId && !item.read_at);
    if (!matching.length) return;
    const readAt = new Date().toISOString();
    matching.forEach((item) => { item.read_at = readAt; });
    unreadCount = Math.max(0, unreadCount - matching.length);
    count.textContent = String(unreadCount);
    if (dialog.open) renderNotifications();
    const { error } = await client.from("portal_notifications").update({ read_at: readAt })
      .in("id", matching.map((item) => item.id)).is("read_at", null);
    if (error) {
      matching.forEach((item) => { item.read_at = null; });
      unreadCount += matching.length;
      count.textContent = String(unreadCount);
      if (dialog.open) renderNotifications();
      toast(error.message || "Could not update notification status.", "error");
      return;
    }
  }

  function updateAssignmentDialog(total) {
    const dialogEl = document.querySelector("#rider-assignment-dialog");
    const number = total <= 10
      ? ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][total]
      : String(total);
    dialogEl.querySelector("h2").textContent = total === 1 ? "New job request" : "New job requests";
    dialogEl.querySelector("p").textContent = total === 1
      ? "A new job request has been assigned to you."
      : `${number} new job requests have been assigned to you.`;
  }

  async function showAssignment() {
    blocking = true;
    const dialogEl = document.querySelector("#rider-assignment-dialog");
    updateAssignmentDialog(pendingAssignments.size);
    dialogEl.dataset.blocking = "true";
    dialogEl.showModal();
    await new Promise((resolve) => {
      const ok = dialogEl.querySelector("[data-assignment-ok]");
      const close = async () => {
        const assignments = [...pendingAssignments.values()];
        pendingAssignments.clear();
        dialogEl.dataset.blocking = "false";
        dialogEl.querySelector("p").textContent = "";
        dialogEl.close();
        ok.removeEventListener("click", close);
        dialogEl.querySelector("[data-assignment-close]").removeEventListener("click", close);
        blocking = false;
        try {
          await Promise.all(assignments.map(markRead));
        } catch (error) {
          toast(error.message || "Could not mark the assignment notifications read.", "error");
        }
        resolve();
      };
      ok.addEventListener("click", close);
      dialogEl.querySelector("[data-assignment-close]").addEventListener("click", close);
    });
    await refresh();
  }

  function renderNotifications() {
    list.innerHTML = notifications.length ? notifications.map((item) => {
      const label = notificationLabel(item.notification_type);
      const destination = notificationDestination(item, profile);
      return `<article class="portal-notification${item.read_at ? " read" : ""}"><div><strong>${escape(label)}</strong><small>${escape(formatTime(item.created_at))}</small></div>
        <a href="${escape(destination)}" data-open-notification="${escape(item.related_id)}">Open</a></article>`;
    }).join("") : '<p class="empty-state">No notifications.</p>';
    list.querySelectorAll("[data-open-notification]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      void markRelatedRead(link.dataset.openNotification).finally(() => { location.href = link.href; });
    }));
  }

  button.addEventListener("click", async () => {
    dialog.showModal();
    renderNotifications();
    await markNotificationsRead();
    await refresh();
    await markNotificationsRead();
  });
  document.querySelectorAll("[data-close-notifications]").forEach((close) => close.addEventListener("click", () => dialog.close()));
  channel = client.channel(`portal-notifications-${profile.id}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "portal_notifications", filter: `recipient_id=eq.${profile.id}`
    }, () => { void refresh(); })
    .subscribe();
  const poll = () => { if (!document.hidden) void refresh(); };
  timer = window.setInterval(poll, 30000);
  const onVisibilityChange = () => {
    if (!document.hidden) void refresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const onRelatedEntry = (event) => { void markRelatedRead(event.detail); };
  document.addEventListener("portal:mark-entry-read", onRelatedEntry);
  window.addEventListener("pagehide", () => {
    if (timer !== null) window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("portal:mark-entry-read", onRelatedEntry);
    if (channel) void client.removeChannel(channel);
  }, { once: true });
  await refresh();
  renderNotifications();

  async function markNotificationsRead() {
    const unread = notifications.filter((item) => !item.read_at);
    if (!unread.length) return;
    const readAt = new Date().toISOString();
    unread.forEach((item) => { item.read_at = readAt; });
    unreadCount = Math.max(0, unreadCount - unread.length);
    count.textContent = String(unreadCount);
    renderNotifications();
    const { error } = await client.from("portal_notifications").update({ read_at: readAt })
      .in("id", unread.map((item) => item.id)).is("read_at", null);
    if (error) {
      unread.forEach((item) => { item.read_at = null; });
      unreadCount += unread.length;
      count.textContent = String(unreadCount);
      renderNotifications();
      toast(error.message || "Could not mark notifications read.", "error");
    }
  }
}

function notificationDestination(item, profile) {
  const type = item.notification_type;
  const page = type.startsWith("artwork_work_note_")
    ? profile.role === "salesperson" ? "sales.html" : "designer.html"
    : type.startsWith("delivery_") ? "deliveries.html"
    : type === "rider_job_assigned" && profile.role === "rider" ? "my-jobs.html"
      : type === "rider_request_new" && hasRouteAdminAccess(profile) ? "route-admin.html" : "riders.html";
  return `./${page}?open=${encodeURIComponent(item.related_id)}`;
}

function notificationLabel(type) {
  return {
    delivery_new: "New delivery request",
    delivery_goods_status: "Production store request submitted or updated",
    delivery_ready: "Delivery is ready to pack",
    delivery_dispatched: "Delivery packed",
    delivery_delivered: "Delivery completed",
    rider_request_new: "New rider request",
    rider_request_declined: "Rider request declined",
    rider_job_assigned: "New rider job assigned",
    rider_job_assigned_sales: "Rider assigned to your request",
    rider_job_started: "Rider started your job",
    rider_job_finished: "Rider finished your job",
    artwork_work_note_designer: "Designer added a work note",
    artwork_work_note_salesperson: "Salesperson replied to a work note"
  }[type] || "Update";
}
