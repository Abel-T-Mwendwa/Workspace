import { client } from "../core/supabase-client.js";
import { startVisibleRefresh } from "../core/visible-refresh.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { initializeScrollableTables } from "../ui/scrollable-table.js";
import { renderStatusChipButtons } from "../ui/status-chips.js";
import { escapeHtml } from "../utils/escape-html.js";
import { debounce } from "../utils/debounce.js";
import { dateKey, localDateTime } from "../utils/dates.js";
import { hourlySlots } from "../utils/delivery-slots.js";
import { riderRequestAvailability, riderRequestSlots, validateRiderRequestSlot } from "../utils/rider-request-slots.js";
import { activityPeriodSummary, activityPeriodDetail, activityRows, renderActivityReport, renderPeriodSummary, bindPeriodSummary } from "../features/activity-panel.js";
import { hasRouteAdminAccess, hasRiderRequestAccess } from "../portal.js";

let profile;
let page;

const ROUTE_STATUS_CHIPS = [
  { value: "active", label: "Active", style: "pending" },
  { value: "In progress", label: "In progress", style: "ready" },
  { value: "Finished", label: "Finished", style: "ready" },
  { value: "", label: "All", style: "all" }
];
let routeRiderChipFilter = "__unassigned";
let routeStatusChipFilter = "active";
let riderJobRows = [];
let riderJobsLastLoadedAt = 0;
let riderOffset = 0;
let riderHasMore = false;
let riderQueryToken = 0;
let riderUsers = [];
let requesterNames = new Map();
let routeRiderTotalCount = 0;
let routePillCountRows = [];
let routeActivityTileFilter = null;
let routeActivityRows = [];
const ROUTE_RIDER_FILTERS_KEY = "routeRiderFilters";
let activeRiderJobCount = 0;
const RIDER_PAGE_SIZE = 20;
let routeScrollSyncing = false;

export function setRouteActivityRows(rows) {
  routeActivityRows = rows;
}

function riderTimeSlots() {
  return hourlySlots();
}

function riderSlotText(row) {
  if (!row.rider_time) return "Not assigned yet";
  return `${row.rider_time.slice(0, 5)} – ${row.rider_time_end?.slice(0, 5) || "—"}`;
}

function riderExpectedTime(row) {
  return row.expected_time ? row.expected_time.slice(0, 5) : "Any time";
}

async function submitRiderRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  const timeMessage = document.querySelector("#rider-request-time-message");
  const timeError = validateRiderRequestSlot(values.scheduled_date, values.expected_time);
  if (timeError) {
    timeMessage.textContent = timeError;
    timeMessage.classList.remove("hidden");
    refreshRiderRequestSlots(form);
    return;
  }
  timeMessage.textContent = "";
  timeMessage.classList.add("hidden");
  setBusy(button, true, "Requesting…");
  try {
    const { data, error } = await client.from("rider_jobs").insert({
      created_by: profile.id,
      client_name: values.client_name.trim(),
      contact_name: values.contact_name.trim(),
      contact_number: values.contact_number.trim(),
      address: values.address.trim(),
      job_type: values.job_type,
      details: values.details.trim(),
      expected_time: values.expected_time === "any" ? null : values.expected_time,
      scheduled_date: values.scheduled_date
    }).select("id,ref_no").single();
    if (error) throw error;
    toast(`Rider request saved as ${data.ref_no}.`);
    form.reset();
    initializeRiderRequestDate(form);
    await loadRiderJobs(true);
    document.querySelector("#rider-period").dispatchEvent(new Event("change"));
  } catch (error) {
    toast(error.message || "Could not save the rider request.", "error");
  } finally {
    setBusy(button, false);
  }
}

function refreshRiderRequestSlots(form) {
  const dateInput = form.elements.scheduled_date;
  const timeSelect = form.elements.expected_time;
  let availability = riderRequestAvailability(dateInput.value);
  dateInput.min = availability.minDate;
  if (dateInput.value && dateInput.value < availability.minDate) {
    dateInput.value = availability.minDate;
    availability = riderRequestAvailability(dateInput.value);
  }
  const previousTime = timeSelect.value;
  const available = new Set(availability.availableSlots.map(([time]) => time));
  const dateAllowed = Boolean(dateInput.value) && dateInput.value >= availability.minDate;
  timeSelect.innerHTML = '<option value="">Choose expected time</option>'
    + `<option value="any"${dateAllowed ? "" : " disabled"}>Any time</option>`
    + riderRequestSlots().map((slot) => {
      const endHour = Number(slot.value.slice(0, 2)) + 1;
      const endLabel = `${endHour % 12 || 12}:00 ${endHour < 12 ? "AM" : "PM"}`;
      return `<option value="${slot.value}"${available.has(slot.value) ? "" : " disabled"}>${slot.label} - ${endLabel}${available.has(slot.value) ? "" : " - unavailable"}</option>`;
    }).join("");
  timeSelect.value = previousTime === "any" && dateAllowed || available.has(previousTime) ? previousTime : "";
  document.querySelector("#rider-request-slot-hint").textContent = availability.hint;
}

function initializeRiderRequestDate(form) {
  const availability = riderRequestAvailability("");
  form.elements.scheduled_date.min = availability.minDate;
  form.elements.scheduled_date.value = availability.minDate;
  refreshRiderRequestSlots(form);
}

async function loadRiderUsers() {
  const { data, error } = await client.from("profiles")
    .select("id,username,full_name,active")
    .eq("role", "rider")
    .order("full_name");
  if (error) throw error;
  riderUsers = data || [];
}

function routeRiderFilterValues() {
  return {
    rider: routeRiderChipFilter,
    status: routeStatusChipFilter
  };
}

function saveRouteRiderFilters() {
  try {
    sessionStorage.setItem(ROUTE_RIDER_FILTERS_KEY, JSON.stringify(routeRiderFilterValues()));
  } catch (error) {
    console.error("Could not save Route admin filters for this session.", error);
    toast("Could not save Route admin filters for this session.", "error");
  }
}

function restoreRouteRiderFilters() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(ROUTE_RIDER_FILTERS_KEY) || "null");
  } catch (error) {
    console.error("Could not read Route admin filters for this session.", error);
    return;
  }
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.rider === "string") routeRiderChipFilter = saved.rider;
  if (ROUTE_STATUS_CHIPS.some(({ value }) => value === saved.status)) {
    routeStatusChipFilter = saved.status;
  } else if (["Not started", "Started", "Declined", "not-started", "started", "declined"].includes(saved.status)) {
    routeStatusChipFilter = "active";
  }
}

function applyRouteSearch(query, search) {
  if (!search) return query;
  const term = JSON.stringify(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
  return query.or(`ref_no.ilike.${term},client_name.ilike.${term}`);
}

async function loadRoutePillCountRows(search) {
  let offset = 0;
  const rows = [];
  while (true) {
    let query = client.from("rider_jobs")
      .select("id,assigned_rider,status,scheduled_date,ref_no,client_name")
      .neq("status", "Deleted")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    query = applyRouteSearch(query, search);
    const { data, error } = await query.range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
    offset += 1000;
  }
  routePillCountRows = rows;
}

async function initializeRouteRiderFilters() {
  restoreRouteRiderFilters();
  const activeRiderIds = new Set(riderUsers.filter((rider) => rider.active).map((rider) => rider.id));
  if (routeRiderChipFilter !== "__unassigned" && routeRiderChipFilter !== ""
    && !activeRiderIds.has(routeRiderChipFilter)) routeRiderChipFilter = "__unassigned";
  document.querySelector("#route-search").addEventListener("input", debounce(() => {
    void loadRiderJobs(true);
  }));
  saveRouteRiderFilters();
}

async function loadRiderJobs(reset = true) {
  const token = ++riderQueryToken;
  const previousIds = new Set(riderJobRows.map((row) => row.id));
  const wasLoaded = riderJobRows.length > 0;
  if (reset) {
    riderOffset = 0;
    riderHasMore = false;
  }
  const myJobs = page === "my-jobs.html";
  if (myJobs) {
    document.querySelector("#my-jobs-loading").classList.remove("hidden");
    document.querySelector("#my-jobs-empty").classList.add("hidden");
    document.querySelector("#my-jobs-error").classList.add("hidden");
    document.querySelector("#my-jobs-more").classList.add("hidden");
    document.querySelector("#my-jobs-list").setAttribute("aria-busy", "true");
    if (reset) document.querySelector("#my-jobs-list").classList.add("hidden");
  }
  const routeAdmin = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const search = document.querySelector("#route-search")?.value.trim() || "";
  const routeFilters = routeAdmin ? routeRiderFilterValues() : null;
  let base = client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at", routeAdmin || myJobs ? { count: "exact" } : undefined);
  if (routeAdmin) {
    base = base.neq("status", "Deleted");
    if (routeFilters.rider === "__unassigned") base = base.is("assigned_rider", null);
    else {
      base = base.eq("scheduled_date", dateKey(new Date()));
      if (routeFilters.rider) base = base.eq("assigned_rider", routeFilters.rider);
    }
    const statuses = routeFilters.status === "active"
      ? ["Not started", "Started", "In progress"]
      : routeFilters.status === "In progress" ? ["Started", "In progress"]
        : routeFilters.status ? [routeFilters.status] : null;
    if (statuses) base = base.in("status", statuses);
  }
  if (profile.role === "rider" && !routeAdmin) base = base.eq("assigned_rider", profile.id).neq("status", "Deleted");
  else if (!routeAdmin) base = base.eq("created_by", profile.id);
  if (myJobs) {
    const filter = document.querySelector("#my-jobs-filter").value;
    if (filter === "active") base = base.or("status.neq.Finished,status.is.null");
    else if (filter === "finished") base = base.eq("status", "Finished");
  }
  try {
    if (routeAdmin && reset) await loadRoutePillCountRows(search);
    if (routeAdmin) base = applyRouteSearch(base, search);
    else if (search) base = base.ilike("client_name", `%${search}%`);
    if (myJobs) console.log("[TEMP-DEBUG] query start", { riderId: profile.id, reset, offset: riderOffset }); // TEMP-DEBUG
    let orderedQuery = base.order(routeAdmin ? "created_at" : "sr", { ascending: !routeAdmin });
    if (myJobs) orderedQuery = orderedQuery.order("id", { ascending: true });
    const { data, error, count } = await orderedQuery.range(riderOffset, riderOffset + RIDER_PAGE_SIZE - 1);
    if (myJobs) console.log("[TEMP-DEBUG] query result", { rows: data?.length || 0, count, error }); // TEMP-DEBUG
    if (error) throw error;
    const rows = data || [];
    if (token !== riderQueryToken) return;
    riderJobRows = reset ? rows : [...riderJobRows, ...rows.filter((row) => !riderJobRows.some((old) => old.id === row.id))];
    riderOffset = reset ? rows.length : riderOffset + rows.length;
    if (routeAdmin) routeRiderTotalCount = count || 0;
    if (myJobs) riderHasMore = riderOffset < (count || 0);
    if (profile.role === "rider") {
      try {
        const activeResult = await client.from("rider_jobs").select("id", { count: "exact", head: true })
          .eq("assigned_rider", profile.id).eq("status", "In progress");
        if (activeResult.error) throw activeResult.error;
        activeRiderJobCount = activeResult.count || 0;
      } catch (error) {
        if (!myJobs) throw error;
        activeRiderJobCount = 1;
        console.error("[TEMP-DEBUG] active-job count error", error); // TEMP-DEBUG
        toast(error.message || "Could not check active rider jobs.", "error");
      }
    }
    if (token !== riderQueryToken) return;
    if (profile.role === "rider" || page === "my-jobs.html") renderMyJobs();
    else renderRiderJobs();
    if (wasLoaded) {
      document.querySelectorAll("#route-rider-rows [data-entry-id], #sales-rider-rows [data-entry-id], #my-jobs-list [data-entry-id]")
        .forEach((row) => {
          if (!previousIds.has(row.dataset.entryId)) row.classList.add("portal-new-row");
        });
    }
    document.querySelector("#route-more")?.classList.toggle("hidden", routeAdmin
      ? riderOffset >= routeRiderTotalCount
      : rows.length < RIDER_PAGE_SIZE);
    riderJobsLastLoadedAt = Date.now();
  } catch (error) {
    if (token !== riderQueryToken) return;
    if (myJobs) {
      riderHasMore = false;
      document.querySelector("#my-jobs-loading").classList.add("hidden");
      document.querySelector("#my-jobs-empty").classList.add("hidden");
      document.querySelector("#my-jobs-error").classList.remove("hidden");
      document.querySelector("#my-jobs-more").classList.add("hidden");
      document.querySelector("#my-jobs-list").setAttribute("aria-busy", "false");
      console.error("[TEMP-DEBUG] query error", error); // TEMP-DEBUG
    }
    toast(error.message || "Could not load rider requests.", "error");
  }
}

function riderAssignmentControls(row) {
  if (row.status !== "Not started" || !hasRouteAdminAccess(profile)) {
    return row.assigned_rider ? escapeHtml(riderUsers.find((user) => user.id === row.assigned_rider)?.full_name || "Assigned rider") : "—";
  }
  const riderOptions = riderUsers.filter((user) => user.active).map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`).join("");
  const slots = riderTimeSlots().map((slot) =>
    `<option value="${slot.start}" data-end="${slot.end}">${escapeHtml(slot.label)}</option>`).join("");
  return `<div class="rider-assignment-control"><select data-rider-choice="${escapeHtml(row.id)}"><option value="">Choose rider</option>${riderOptions}</select>
    <select data-rider-slot="${escapeHtml(row.id)}"><option value="">Choose hourly slot</option>${slots}</select>
    <button type="button" class="primary" data-rider-assign="${escapeHtml(row.id)}">Assign</button></div>`;
}

function renderRouteRiderChips() {
  const today = dateKey(new Date());
  const chips = [
    { value: "__unassigned", label: "Pending", style: "pending" },
    { value: "", label: "All", style: "all" },
    ...riderUsers.filter((rider) => rider.active).map((rider) =>
      ({ value: rider.id, label: rider.full_name, style: "ready" }))
  ];
  const counts = new Map(chips.map(({ value }) => {
    const count = routePillCountRows.filter((row) => routeStatusFilterMatches(row, routeStatusChipFilter)
      && (value === "__unassigned" ? !row.assigned_rider
        : value === "" ? row.scheduled_date === today
          : row.assigned_rider === value && row.scheduled_date === today)).length;
    return [value, count];
  }));
  if (routeRiderChipFilter !== "__unassigned" && routeRiderChipFilter !== ""
    && !chips.some(({ value }) => value === routeRiderChipFilter)) routeRiderChipFilter = "__unassigned";
  renderStatusChipButtons(document.querySelector("#route-rider-chips"), chips, counts,
    routeRiderChipFilter, (value) => {
      routeRiderChipFilter = value;
      saveRouteRiderFilters();
      void loadRiderJobs(true);
    }, "riderFilter");
}

function routeStatusFilterMatches(row, value) {
  if (!value) return true;
  if (value === "active") return !["Finished", "Declined"].includes(row.status);
  if (value === "In progress") return ["Started", "In progress"].includes(row.status);
  return row.status === value;
}

function renderRouteActivityRows(rows) {
  const multiDay = document.querySelector("#route-period").value !== "day";
  const timeMinutes = (row) => {
    if (!row.rider_time) return null;
    const [hours, minutes] = row.rider_time.split(":").map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
  };
  const riderName = (row) => row.assigned_rider
    ? riderUsers.find((user) => user.id === row.assigned_rider)?.full_name || "Assigned rider"
    : "Not assigned";
  const orderedRows = [...rows].sort((a, b) => {
    const aMinutes = timeMinutes(a);
    const bMinutes = timeMinutes(b);
    if (aMinutes === null || bMinutes === null) {
      if (aMinutes !== bMinutes) return aMinutes === null ? 1 : -1;
      return String(a.created_at || "").localeCompare(String(b.created_at || ""))
        || String(a.id || "").localeCompare(String(b.id || ""));
    }
    if (multiDay) {
      const dateOrder = String(a.scheduled_date || "").localeCompare(String(b.scheduled_date || ""));
      if (dateOrder) return dateOrder;
    }
    return aMinutes - bMinutes
      || riderName(a).localeCompare(riderName(b))
      || String(a.client_name || "").localeCompare(String(b.client_name || ""))
      || String(a.id || "").localeCompare(String(b.id || ""));
  });
  return orderedRows.map((row) => {
    const salesperson = requesterNames.get(row.created_by) || "Salesperson";
    const riderTime = `${escapeHtml(riderSlotText(row))}${multiDay && row.scheduled_date
      ? `<br><small>${escapeHtml(row.scheduled_date)}</small>` : ""}`;
    return `<tr><td>${riderTime}</td><td>${escapeHtml(salesperson)}</td><td>${escapeHtml(row.client_name || "—")}<br><small>${escapeHtml(row.contact_name || "—")} · ${escapeHtml(row.contact_number || "—")}</small></td><td>${escapeHtml(row.address || "—")}<br><small>${escapeHtml(row.details || "")}</small></td><td>${escapeHtml(riderName(row))}</td><td>${escapeHtml(row.status)}</td></tr>`;
  }).join("");
}

function renderRouteStatusChips() {
  const today = dateKey(new Date());
  const counts = new Map(ROUTE_STATUS_CHIPS.map(({ value }) => [value,
    routePillCountRows.filter((row) => {
      const riderMatches = routeRiderChipFilter === "__unassigned"
        ? !row.assigned_rider
        : routeRiderChipFilter === "" ? row.scheduled_date === today
          : row.assigned_rider === routeRiderChipFilter && row.scheduled_date === today;
      return riderMatches && routeStatusFilterMatches(row, value);
    }).length
  ]));
  renderStatusChipButtons(document.querySelector("#route-status-chips"), ROUTE_STATUS_CHIPS, counts,
    routeStatusChipFilter, (value) => {
      routeStatusChipFilter = value;
      saveRouteRiderFilters();
      void loadRiderJobs(true);
    }, "statusChip");
}

const routeRowsAnimating = new Set();
let routeRenderQueued = false;

function renderRiderJobs() {
    if (page === "route-admin.html" && routeRowsAnimating.size) {
      routeRenderQueued = true;
      return;
    }
  const routeView = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const showSalesView = hasRiderRequestAccess(profile) && page === "riders.html";
  const assignmentValues = new Map([...(document.querySelector("#route-rider-rows")?.querySelectorAll("[data-rider-choice]") || [])]
    .map((select) => {
      const id = select.dataset.riderChoice;
      return [id, {
        rider: select.value,
        slot: document.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`)?.value || ""
      }];
    }));
  const search = document.querySelector("#route-search")?.value.trim().toLowerCase() || "";
  const status = routeView ? "" : document.querySelector("#sales-rider-filter")?.value || "";
  const searchedRows = riderJobRows.filter((row) => !search
    || `${row.ref_no} ${row.client_name}${routeView ? "" : ` ${row.address}`}`.toLowerCase().includes(search));
  const statusRows = routeView
    ? searchedRows.filter((row) => routeStatusFilterMatches(row, routeStatusChipFilter))
    : searchedRows.filter((row) => !status || row.status === status);
  const riderRows = routeView
    ? searchedRows.filter((row) => routeRiderChipFilter === ""
      || (routeRiderChipFilter === "__unassigned" ? !row.assigned_rider : row.assigned_rider === routeRiderChipFilter))
    : statusRows;
  const matchingRows = routeView
    ? statusRows.filter((row) => routeRiderChipFilter === ""
      || (routeRiderChipFilter === "__unassigned" ? !row.assigned_rider : row.assigned_rider === routeRiderChipFilter))
    : riderRows;
  if (routeView) {
    renderRouteRiderChips();
    renderRouteStatusChips();
  }
  const markup = (rows, canAssign) => rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}">${canAssign
    ? `<td class="col-sr-ref"><strong>${escapeHtml(row.sr)} · ${escapeHtml(row.ref_no)}</strong></td>`
    : `<td><strong>${escapeHtml(row.sr)} · ${escapeHtml(row.ref_no)}</strong></td>`}
    ${canAssign ? `<td>${escapeHtml(requesterNames.get(row.created_by) || "Salesperson")}</td>` : ""}
    <td>${escapeHtml(row.client_name)}<br><small>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</small></td>
    <td>${escapeHtml(row.address)}<br><small>${escapeHtml(row.details)}</small></td><td>${escapeHtml(row.job_type)}</td>
    <td>${escapeHtml(riderExpectedTime(row))} · ${escapeHtml(row.scheduled_date)}</td>
    ${canAssign ? `<td>${escapeHtml(localDateTime(row.created_at))}</td>` : ""}
    <td>${canAssign ? riderAssignmentControls(row) : escapeHtml(row.assigned_rider ? riderUsers.find((user) => user.id === row.assigned_rider)?.full_name || "Assigned rider" : "Not assigned yet")}</td><td>${escapeHtml(riderSlotText(row))}</td>
    <td>${escapeHtml(row.status)}${row.decline_reason ? `<br><small>${escapeHtml(localDateTime(row.declined_at))} · ${escapeHtml(row.decline_reason)}</small>` : ""}${row.started_at ? `<br><small>Started ${escapeHtml(localDateTime(row.started_at))}</small>` : ""}${row.finished_at ? `<br><small>Finished ${escapeHtml(localDateTime(row.finished_at))}</small>` : ""}</td>
    ${canAssign ? `<td>${!row.assigned_rider && row.status === "Not started"
      ? `<button type="button" class="danger" data-rider-decline="${escapeHtml(row.id)}">Decline</button>`
      : row.assigned_rider && row.status !== "Deleted"
        ? `<button type="button" class="danger" data-rider-delete="${escapeHtml(row.id)}"${row.started_at || ["In progress", "Finished"].includes(row.status) ? ' disabled title="Rider has already started this entry"' : ""}>Delete</button>`
        : "—"}</td>` : ""}</tr>`).join("");
  if (routeView) {
    const routeRows = document.querySelector("#route-rider-rows");
    routeRows.innerHTML = markup(matchingRows, true);
    initializeScrollableTables(routeRows.closest("table"));
    refreshRouteStickyScrollbar();
    assignmentValues.forEach((values, id) => {
      const rider = routeRows.querySelector(`[data-rider-choice="${CSS.escape(id)}"]`);
      const slot = routeRows.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`);
      if (rider) rider.value = values.rider;
      if (slot) slot.value = values.slot;
    });
    const empty = document.querySelector("#route-rider-empty");
    if (!matchingRows.length) {
      empty.replaceChildren();
      if (!statusRows.length) {
        empty.textContent = "No matching requests.";
      } else {
        const selectedChip = routeRiderChipFilter === "__unassigned"
          ? { label: "Pending" }
          : riderUsers.find((rider) => rider.id === routeRiderChipFilter) || { label: "All" };
        empty.append(document.createTextNode(`No ${selectedChip.label} requests.`));
      }
      const statusAlternative = ROUTE_STATUS_CHIPS.find(({ value }) =>
        value !== routeStatusChipFilter && riderRows.some((row) => routeStatusFilterMatches(row, value)));
      const riderAlternative = [
        { value: "__unassigned", label: "Pending" },
        ...riderUsers.map((rider) => ({ value: rider.id, label: rider.full_name })),
        { value: "", label: "All" }
      ].find(({ value }) => value !== routeRiderChipFilter && statusRows.some((row) =>
        value === "" || (value === "__unassigned" ? !row.assigned_rider : row.assigned_rider === value)));
      if (statusAlternative) {
        const count = riderRows.filter((row) => routeStatusFilterMatches(row, statusAlternative.value)).length;
        empty.append(document.createElement("br"), document.createTextNode(`${count} in ${statusAlternative.label}, `));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet production-ready-link";
        button.textContent = "view them";
        button.addEventListener("click", () => {
          routeStatusChipFilter = statusAlternative.value;
          saveRouteRiderFilters();
          renderRiderJobs();
        });
        empty.append(button);
      } else if (riderAlternative) {
        const count = statusRows.filter((row) => riderAlternative.value === ""
          || (riderAlternative.value === "__unassigned" ? !row.assigned_rider : row.assigned_rider === riderAlternative.value)).length;
        empty.append(document.createElement("br"), document.createTextNode(`${count} in ${riderAlternative.label}, `));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet production-ready-link";
        button.textContent = "view them";
        button.addEventListener("click", () => {
          routeRiderChipFilter = riderAlternative.value;
          saveRouteRiderFilters();
          renderRiderJobs();
        });
        empty.append(button);
      }
    }
    empty.classList.toggle("hidden", matchingRows.length > 0);
    const requestCount = routeRiderTotalCount === 1 ? "request" : "requests";
    document.querySelector("#route-results-count").textContent = matchingRows.length < routeRiderTotalCount
      ? `Showing ${matchingRows.length} of ${routeRiderTotalCount} ${requestCount}`
      : `Showing ${matchingRows.length} ${requestCount}`;
    const filters = routeRiderFilterValues();
    const active = [];
    if (filters.rider) {
      active.push(`Rider: ${filters.rider === "__unassigned"
        ? "Pending"
        : riderUsers.find((rider) => rider.id === filters.rider)?.full_name || "All riders"}`);
    }
    const selectedStatus = ROUTE_STATUS_CHIPS.find(({ value }) => value === filters.status);
    if (selectedStatus && selectedStatus.value !== "") active.push(`Status: ${selectedStatus.label}`);
    if (search) active.push(`Search: ${search}`);
    document.querySelector("#route-active-filters").textContent = active.length
      ? `Active filters: ${active.join(" · ")}`
      : "No active filters";
  }
  if (showSalesView) {
    const salesRows = matchingRows.filter((row) => row.created_by === profile.id);
    const salesRoot = document.querySelector("#sales-rider-rows");
    salesRoot.innerHTML = markup(salesRows, false);
    initializeScrollableTables(salesRoot.closest("table"));
    document.querySelector("#sales-rider-empty")?.classList.toggle("hidden", salesRows.length > 0);
  }
  const loadMore = document.querySelector("#route-more");
  if (loadMore) loadMore.classList.toggle("hidden", !routeView || riderOffset >= routeRiderTotalCount);
  document.querySelector("#sales-rider-more")?.classList.toggle("hidden", !showSalesView || riderJobRows.length < RIDER_PAGE_SIZE);
  const roots = [routeView ? document.querySelector("#route-rider-rows") : null,
    showSalesView ? document.querySelector("#sales-rider-rows") : null].filter(Boolean);
  roots.forEach((root) => {
    root.querySelectorAll("[data-rider-assign]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.riderAssign;
      if (routeRowsAnimating.has(id)) return;
      const riderId = root.querySelector(`[data-rider-choice="${CSS.escape(id)}"]`).value;
      const slotSelect = root.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`);
      const slot = slotSelect.value;
      const end = slotSelect.selectedOptions[0]?.dataset.end;
      if (!riderId || !slot || !end) {
        toast("Choose a rider and hourly slot before assigning.", "error");
        return;
      }
      const row = button.closest("tr");
      routeRowsAnimating.add(id);
      const updated = await updateRiderJob(id, {
        assigned_rider: riderId, rider_time: slot, rider_time_end: end, status: "Started",
        ...(profile.role === "admin" ? { assigned_at: new Date().toISOString() } : {})
      }, button);
      if (!updated) {
        finishRouteRowAction(id);
        return;
      }
      updateRouteJobCache(updated);
      try {
        await animateRouteAction(row, "assign", routeRowMatchesActiveFilters(updated));
        toast(routeView && routeRiderChipFilter === "__unassigned"
          ? "Rider assigned; removed from the unassigned list."
          : "Rider assigned.");
        await loadRiderJobs(true);
      } finally {
        finishRouteRowAction(id);
      }
    }));
    root.querySelectorAll("[data-rider-decline]").forEach((button) => button.addEventListener("click", async () => {
      const reason = window.prompt("Why is this rider request being declined?");
      if (reason === null) return;
      if (!reason.trim()) {
        toast("Enter a reason before declining the request.", "error");
        return;
      }
      const id = button.dataset.riderDecline;
      if (routeRowsAnimating.has(id)) return;
      const row = button.closest("tr");
      routeRowsAnimating.add(id);
      const updated = await updateRiderJob(id, {
        status: "Declined", decline_reason: reason.trim(),
        ...(profile.role === "admin" ? { declined_at: new Date().toISOString() } : {})
      }, button);
      if (!updated) {
        finishRouteRowAction(id);
        return;
      }
      updateRouteJobCache(updated);
      try {
        await animateRouteAction(row, "remove", routeRowMatchesActiveFilters(updated));
        toast("Rider request declined.");
        await loadRiderJobs(true);
      } finally {
        finishRouteRowAction(id);
      }
    }));
    root.querySelectorAll("[data-rider-delete]").forEach((button) => button.addEventListener("click", async () => {
      if (button.disabled) return;
      const id = button.dataset.riderDelete;
      if (routeRowsAnimating.has(id)) return;
      const row = button.closest("tr");
      routeRowsAnimating.add(id);
      setBusy(button, true);
      let refresh = false;
      try {
        const { data, error } = await client.rpc("route_admin_delete_rider_job", { p_job_id: id });
        if (error) throw error;
        const updated = Array.isArray(data) ? data[0] : data;
        if (!updated) {
          toast("Rider has already started this entry", "error");
        } else {
          updateRouteJobCache(updated);
          await animateRouteAction(row, "remove", routeRowMatchesActiveFilters(updated));
          toast("Rider request deleted.");
        }
        refresh = true;
      } catch (error) {
        toast(error.message || "Could not delete rider request.", "error");
        refresh = true;
      } finally {
        if (refresh) await loadRiderJobs(true);
        finishRouteRowAction(id);
        setBusy(button, false);
      }
    }));
  });
}

function finishRouteRowAction(id) {
  routeRowsAnimating.delete(id);
  if (!routeRowsAnimating.size && routeRenderQueued) {
    routeRenderQueued = false;
    renderRiderJobs();
  }
}

function updateRouteJobCache(updated) {
  if (updated.status === "Deleted") {
    riderJobRows = riderJobRows.filter((row) => row.id !== updated.id);
    return;
  }
  const index = riderJobRows.findIndex((row) => row.id === updated.id);
  if (index >= 0) riderJobRows[index] = updated;
  else riderJobRows.push(updated);
}

function routeRowMatchesActiveFilters(row) {
  if (row.status === "Deleted") return false;
  const search = document.querySelector("#route-search")?.value.trim().toLowerCase() || "";
  if (search && !`${row.ref_no} ${row.client_name}`.toLowerCase().includes(search)) return false;
  if (!routeStatusFilterMatches(row, routeStatusChipFilter)) return false;
  if (routeRiderChipFilter === "__unassigned") return !row.assigned_rider;
  if (row.scheduled_date !== dateKey(new Date())) return false;
  return !routeRiderChipFilter || row.assigned_rider === routeRiderChipFilter;
}

function waitForRouteTransition(element, propertyName, timeoutMs) {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      element.removeEventListener("transitionend", onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = (event) => {
      if (event.propertyName === propertyName) finish();
    };
    const timeout = window.setTimeout(finish, timeoutMs);
    element.addEventListener("transitionend", onTransitionEnd);
  });
}

async function animateRouteAction(row, action, staysInView) {
  if (!row?.isConnected) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const actionClass = `route-row-${action}`;
  row.classList.add(actionClass);
  void row.offsetWidth;
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  if (staysInView) {
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 100 : 150));
    row.classList.remove(actionClass);
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 120 : 150));
    return;
  }
  const movement = waitForRouteTransition(row, reducedMotion ? "opacity" : "transform", 600);
  row.classList.add("route-row-leaving");
  await movement;
  if (reducedMotion) {
    row.remove();
    return;
  }
  [...row.cells].forEach((cell) => {
    cell.style.height = `${cell.getBoundingClientRect().height}px`;
  });
  void row.offsetHeight;
  const collapse = waitForRouteTransition(row, "height", 250);
  row.classList.add("route-row-collapsing");
  await collapse;
  row.remove();
}

function refreshRouteStickyScrollbar() {
  const wrapper = document.querySelector("#route-rider-table-wrap");
  const scrollbar = document.querySelector("#route-table-sticky-scrollbar");
  const spacer = scrollbar?.firstElementChild;
  const table = document.querySelector("#route-admin-table");
  if (!wrapper || !scrollbar || !spacer || !table) return;
  spacer.style.width = `${table.scrollWidth}px`;
  scrollbar.classList.toggle("hidden", table.scrollWidth <= wrapper.clientWidth + 1);
  if (!routeScrollSyncing) scrollbar.scrollLeft = wrapper.scrollLeft;
}

function initializeRouteStickyScrollbar() {
  const wrapper = document.querySelector("#route-rider-table-wrap");
  const scrollbar = document.querySelector("#route-table-sticky-scrollbar");
  if (!wrapper || !scrollbar) return;
  wrapper.addEventListener("scroll", () => {
    if (routeScrollSyncing) return;
    routeScrollSyncing = true;
    scrollbar.scrollLeft = wrapper.scrollLeft;
    routeScrollSyncing = false;
  });
  scrollbar.addEventListener("scroll", () => {
    if (routeScrollSyncing) return;
    routeScrollSyncing = true;
    wrapper.scrollLeft = scrollbar.scrollLeft;
    routeScrollSyncing = false;
  });
  window.addEventListener("resize", refreshRouteStickyScrollbar);
}

async function updateRiderJob(id, values, button) {
  setBusy(button, true);
  try {
    const { data, error } = await client.from("rider_jobs").update(values)
      .eq("id", id).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This rider job could not be updated. Refresh and try again.");
    return data;
  } catch (error) {
    toast(error.message || "Could not update rider job.", "error");
    return null;
  } finally {
    setBusy(button, false);
  }
}

export async function initRiders({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  const requestPanel = document.querySelector("#rider-request-panel");
  const routeAdmin = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const canRequest = hasRiderRequestAccess(profile) && page === "riders.html";
  requestPanel.classList.toggle("hidden", !canRequest || page === "route-admin.html");
  document.querySelector("#route-admin-panel").classList.toggle("hidden", !routeAdmin);
  document.querySelector("#riders-list-panel").classList.toggle("hidden", !canRequest || page === "route-admin.html");
  document.querySelector("#route-riders-panel").classList.toggle("hidden", !routeAdmin);
  await loadRiderUsers();
  if (routeAdmin) {
    initializeRouteStickyScrollbar();
    const { data: requesters, error: requestersError } = await client.from("profiles").select("id,full_name").eq("active", true);
    if (requestersError) throw requestersError;
    requesterNames = new Map((requesters || []).map((user) => [user.id, user.full_name]));
    document.querySelector("#route-riders-rows").innerHTML = riderUsers.map((user) =>
      `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.username)}</td><td>${user.active ? "Active" : "Inactive"}</td></tr>`
    ).join("");
    initializeScrollableTables(document.querySelector("#route-riders-rows").closest("table"));
    document.querySelector("#route-more").addEventListener("click", () => { void loadRiderJobs(false); });
    await initializeRouteRiderFilters();
  }
  if (routeAdmin) {
    const tiles = document.querySelector("#route-tallies");
    const routePeriod = document.querySelector("#route-period");
    const dialog = document.querySelector("#delivery-activity-dialog");
    let routeActivityTileTrigger = null;
    const cards = [
      { label: "Received", dateColumn: "created_at", excludeStatus: "Deleted" },
      { label: "Assigned", dateColumn: "assigned_at", excludeStatus: "Deleted" },
      { label: "In progress", dateColumn: "started_at", excludeStatus: "Deleted" },
      { label: "Finished", dateColumn: "finished_at", excludeStatus: "Deleted" },
      { label: "Declined", dateColumn: "declined_at", excludeStatus: "Deleted" }
    ];
    const updateTileSelection = () => {
      tiles.querySelectorAll(".delivery-activity-tile").forEach((tile, index) =>
        tile.setAttribute("aria-pressed", String(routeActivityTileFilter === index)));
    };
    const renderRouteActivityReport = (index) => {
      const card = cards[index];
      if (!card) return;
      const rows = routeActivityRows[index] || [];
      renderActivityReport({
        title: `${card.label}: ${activityPeriodSummary(routePeriod.value, true)}`,
        range: activityPeriodDetail(routePeriod.value),
        total: rows.length,
        printed: localDateTime(new Date()),
        message: rows.length ? "" : "No rider requests match these filters.",
        rows: renderRouteActivityRows(rows)
      });
    };
    const openFromTile = (event) => {
      if (!(event.target instanceof Element)) return;
      const tile = event.target.closest(".delivery-activity-tile");
      if (!tile || !tiles.contains(tile)) return;
      const index = Number(tile.dataset.routeActivityIndex);
      const card = cards[index];
      if (!card) return;
      routeActivityTileFilter = index;
      routeActivityTileTrigger = tile;
      updateTileSelection();
      renderRouteActivityReport(index);
      if (!dialog.open) dialog.showModal();
    };
    tiles.addEventListener("click", openFromTile);
    tiles.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.matches(".delivery-activity-tile")) {
        event.preventDefault();
        event.target.click();
      }
    });
    document.querySelectorAll("[data-delivery-activity-close]").forEach((button) =>
      button.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      const focusTarget = routeActivityTileFilter === null
        ? routeActivityTileTrigger
        : tiles.querySelector(`[data-route-activity-index="${routeActivityTileFilter}"]`) || routeActivityTileTrigger;
      routeActivityTileFilter = null;
      updateTileSelection();
      focusTarget?.focus();
      routeActivityTileTrigger = null;
    });
    document.querySelector("#delivery-activity-print").addEventListener("click", () => window.print());
    bindPeriodSummary("route-period", () => renderPeriodSummary("route-tallies", "route-period", "rider_jobs", cards).then(() => {
      tiles.querySelectorAll(".stat-card").forEach((tile, index) => {
        tile.classList.add("delivery-activity-tile");
        tile.tabIndex = 0;
        tile.setAttribute("role", "button");
        tile.setAttribute("aria-haspopup", "dialog");
        tile.dataset.routeActivityIndex = String(index);
      });
      updateTileSelection();
      if (dialog.open && routeActivityTileFilter !== null) {
        renderRouteActivityReport(routeActivityTileFilter);
      }
    }));
  } else if (canRequest) {
    bindPeriodSummary("rider-period", () => renderPeriodSummary("rider-tallies", "rider-period", "rider_jobs", [
      { label: "Requested", dateColumn: "created_at", filters: { created_by: profile.id } },
      { label: "Assigned", dateColumn: "assigned_at", filters: { created_by: profile.id } },
      { label: "In progress", dateColumn: "started_at", filters: { created_by: profile.id } },
      { label: "Finished", dateColumn: "finished_at", filters: { created_by: profile.id } }
    ]));
  }
  if (canRequest) {
    const requestForm = document.querySelector("#rider-request-form");
    initializeRiderRequestDate(requestForm);
    requestForm.elements.scheduled_date.addEventListener("change", () => {
      refreshRiderRequestSlots(requestForm);
      document.querySelector("#rider-request-time-message").textContent = "";
      document.querySelector("#rider-request-time-message").classList.add("hidden");
    });
    requestForm.elements.expected_time.addEventListener("change", () => {
      document.querySelector("#rider-request-time-message").textContent = "";
      document.querySelector("#rider-request-time-message").classList.add("hidden");
    });
    requestForm.addEventListener("reset", () => {
      window.setTimeout(() => {
        initializeRiderRequestDate(requestForm);
        document.querySelector("#rider-request-time-message").textContent = "";
        document.querySelector("#rider-request-time-message").classList.add("hidden");
      });
    });
    requestForm.addEventListener("submit", submitRiderRequest);
    document.querySelector("#sales-rider-filter").addEventListener("change", renderRiderJobs);
  }
  await loadRiderJobs(true);
  document.querySelector("#sales-rider-more")?.addEventListener("click", () => { void loadRiderJobs(false); });
  client.channel(`rider-jobs-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "rider_jobs"
  }, () => { void loadRiderJobs(true); }).subscribe();
  startVisibleRefresh(async () => {
    if (routeAdmin) {
      await loadRiderUsers();
      const activeRiderIds = new Set(riderUsers.filter((rider) => rider.active).map((rider) => rider.id));
      if (routeRiderChipFilter !== "__unassigned" && routeRiderChipFilter !== ""
        && !activeRiderIds.has(routeRiderChipFilter)) routeRiderChipFilter = "__unassigned";
    }
    await loadRiderJobs(true);
  }, {
    intervalMs: 60000,
    visibilityMinAgeMs: 60000,
    lastRefreshAt: () => riderJobsLastLoadedAt
  });
  const openId = new URLSearchParams(location.search).get("open");
  if (openId && !riderJobRows.some((row) => row.id === openId)) {
    const { data, error } = await client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at")
      .eq("id", openId).maybeSingle();
    if (error) throw error;
    if (data) {
      riderJobRows.push(data);
      renderRiderJobs();
    }
  }
}

function missionOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "mission-overlay";
  overlay.setAttribute("role", "status");
  overlay.innerHTML = "<div>Mission accomplished</div>";
  document.body.append(overlay);
  window.setTimeout(() => overlay.remove(), 2000);
}

function renderMyJobs() {
  const root = document.querySelector("#my-jobs-list");
  const filter = document.querySelector("#my-jobs-filter").value;
  const assigned = riderJobRows.filter((row) => profile.role !== "rider" || row.assigned_rider === profile.id)
    .sort((a, b) => `${a.scheduled_date} ${a.rider_time || ""}`.localeCompare(`${b.scheduled_date} ${b.rider_time || ""}`)
      || String(a.id).localeCompare(String(b.id)));
  const filtered = assigned.filter((row) => filter === "active" ? row.status !== "Finished"
    : filter === "finished" ? row.status === "Finished" : true);
  console.log("[TEMP-DEBUG] render", { loaded: riderJobRows.length, visible: filtered.length, filter }); // TEMP-DEBUG
  const inProgress = profile.role === "rider" ? activeRiderJobCount > 0 : assigned.some((row) => row.status === "In progress");
  root.classList.remove("hidden");
  root.setAttribute("aria-busy", "false");
  root.innerHTML = filtered.map((row) => `<article class="rider-job-card" data-entry-id="${escapeHtml(row.id)}">
    <div class="rider-job-title"><div><span class="home-card-ref">${escapeHtml(row.ref_no)}</span><h2>${escapeHtml(row.client_name)}</h2></div><span class="badge ${row.status === "Finished" ? "done" : row.status === "In progress" ? "progress" : "requested"}">${escapeHtml(row.status)}</span></div>
    <dl><div><dt>Contact</dt><dd>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</dd></div>
      <div><dt>Address</dt><dd>${escapeHtml(row.address)}</dd></div><div><dt>Type / details</dt><dd>${escapeHtml(row.job_type)} · ${escapeHtml(row.details)}</dd></div>
      <div><dt>Expected</dt><dd>${escapeHtml(riderExpectedTime(row))} · ${escapeHtml(row.scheduled_date)}</dd></div>
      <div><dt>Rider time</dt><dd>${escapeHtml(riderSlotText(row))}</dd></div></dl>
    <div class="table-actions">${profile.role === "rider" && row.status === "Started" ? `<button class="primary" data-rider-start="${escapeHtml(row.id)}" ${inProgress ? "disabled" : ""}>Start</button>` : ""}
      ${profile.role === "rider" && row.status === "In progress" ? `<button class="primary" data-rider-finish="${escapeHtml(row.id)}">Finish</button>` : ""}</div></article>`).join("");
  document.querySelector("#my-jobs-loading").classList.add("hidden");
  document.querySelector("#my-jobs-error").classList.add("hidden");
  document.querySelector("#my-jobs-empty").classList.toggle("hidden", filtered.length > 0);
  document.querySelector("#my-jobs-more")?.classList.toggle("hidden", !riderHasMore || !filtered.length);
  root.querySelectorAll("[data-rider-start]").forEach((button) => button.addEventListener("click", () =>
    updateRiderJob(button.dataset.riderStart, { status: "In progress" }, button, "Job started.")));
  root.querySelectorAll("[data-rider-finish]").forEach((button) => button.addEventListener("click", async () => {
    if (await updateRiderJob(button.dataset.riderFinish, { status: "Finished" }, button, "Job finished.")) missionOverlay();
  }));
}

export async function initMyJobs({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  const tiles = document.querySelector("#jobs-tallies");
  const periodSelect = document.querySelector("#jobs-period");
  const dialog = document.querySelector("#delivery-activity-dialog");
  const cards = [
    { label: "Assigned", dateColumn: "assigned_at", filters: { assigned_rider: profile.id } },
    { label: "In progress", dateColumn: "started_at", filters: { assigned_rider: profile.id, status: ["Started", "In progress"] } },
    { label: "Finished", dateColumn: "finished_at", filters: { assigned_rider: profile.id, status: "Finished" } }
  ];
  const columns = "id,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,scheduled_date,rider_time,rider_time_end,status";
  let summaryRequest = 0;
  let reportRequest = 0;
  let reportIndex = null;
  let reportTrigger = null;
  let previousPeriod = periodSelect.value;
  let focusTileAfterPeriodRefresh = null;
  const updateTileSelection = () => tiles.querySelectorAll(".delivery-activity-tile").forEach((tile, index) =>
    tile.setAttribute("aria-pressed", String(reportIndex === index)));
  const refreshActivityTiles = () => {
    const request = ++summaryRequest;
    return renderPeriodSummary("jobs-tallies", "jobs-period", "rider_jobs", cards,
      () => request === summaryRequest).then(() => {
      if (request !== summaryRequest) return;
      tiles.querySelectorAll(".stat-card").forEach((tile, index) => {
        tile.classList.add("delivery-activity-tile");
        tile.tabIndex = 0;
        tile.setAttribute("role", "button");
        tile.setAttribute("aria-haspopup", "dialog");
        tile.setAttribute("aria-pressed", String(reportIndex === index));
        tile.dataset.myJobsActivityIndex = String(index);
      });
      if (focusTileAfterPeriodRefresh !== null) {
        tiles.querySelector(`[data-my-jobs-activity-index="${focusTileAfterPeriodRefresh}"]`)?.focus();
        focusTileAfterPeriodRefresh = null;
      }
    });
  };
  const openFromTile = async (event) => {
    if (!(event.target instanceof Element)) return;
    const tile = event.target.closest(".delivery-activity-tile");
    if (!tile || !tiles.contains(tile)) return;
    const index = Number(tile.dataset.myJobsActivityIndex);
    const card = cards[index];
    if (!card) return;
    const period = periodSelect.value;
    const expectedCount = Number(tile.querySelector("strong")?.textContent || 0);
    const request = ++reportRequest;
    reportIndex = index;
    reportTrigger = tile;
    updateTileSelection();
    const title = `${card.label}: ${activityPeriodSummary(period, true)}`;
    const range = activityPeriodDetail(period);
    const printed = localDateTime(new Date());
    renderActivityReport({ title, range, total: 0, printed, message: "Loading jobs…", rows: "" });
    if (!dialog.open) {
      dialog.showModal();
      dialog.querySelector("[data-delivery-activity-close]")?.focus();
    }
    try {
      const rows = await activityRows("rider_jobs", period, card, columns);
      if (!dialog.open || request !== reportRequest || periodSelect.value !== period) return;
      if (rows.length !== expectedCount) {
        console.warn("My jobs activity tile count differs from its report rows.", {
          tile: card.label, expectedCount, rows: rows.length, period
        });
      }
      renderActivityReport({
        title,
        range,
        total: rows.length,
        printed,
        message: rows.length ? "" : "No jobs match this filter.",
        rows: rows.map((row) => `<tr><td>${escapeHtml(row.client_name)}<br><small>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</small></td><td>${escapeHtml(row.address)}<br><small>${escapeHtml(row.details)}</small></td><td>${escapeHtml(row.job_type)}</td><td>${escapeHtml(riderSlotText(row))}</td><td><span class="badge ${row.status === "Finished" ? "done" : row.status === "In progress" ? "progress" : "requested"}">${escapeHtml(row.status)}</span></td></tr>`).join("")
      });
    } catch (error) {
      if (!dialog.open || request !== reportRequest) return;
      renderActivityReport({
        title,
        range,
        total: 0,
        printed,
        message: "Could not load jobs for this period.",
        rows: ""
      });
      toast(error.message || "Could not load jobs for this period.", "error");
    }
  };
  const updateReportFocus = () => {
    const focusTarget = reportIndex === null
      ? reportTrigger
      : tiles.querySelector(`[data-my-jobs-activity-index="${reportIndex}"]`) || reportTrigger;
    reportIndex = null;
    updateTileSelection();
    focusTarget?.focus();
    reportTrigger = null;
    reportRequest += 1;
  };
  tiles.addEventListener("click", openFromTile);
  tiles.addEventListener("keydown", (event) => {
    if (event.target instanceof Element
      && (event.key === "Enter" || event.key === " ")
      && event.target.matches(".delivery-activity-tile")) {
      event.preventDefault();
      event.target.click();
    }
  });
  document.querySelectorAll("[data-delivery-activity-close]").forEach((button) =>
    button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", updateReportFocus);
  document.querySelector("#delivery-activity-print").addEventListener("click", () => window.print());
  periodSelect.addEventListener("change", () => {
    const changed = periodSelect.value !== previousPeriod;
    previousPeriod = periodSelect.value;
    if (changed && dialog.open) {
      focusTileAfterPeriodRefresh = reportIndex;
      dialog.close();
    }
  });
  bindPeriodSummary("jobs-period", refreshActivityTiles);
  const filterInput = document.querySelector("#my-jobs-filter");
  const filterChips = document.querySelector("#my-jobs-filter-chips");
  filterChips.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-my-jobs-filter]");
    if (!button || button.getAttribute("aria-pressed") === "true") return;
    filterInput.value = button.dataset.myJobsFilter;
    filterChips.querySelectorAll("[data-my-jobs-filter]").forEach((chip) => {
      const selected = chip === button;
      chip.classList.toggle("is-active", selected);
      chip.setAttribute("aria-pressed", String(selected));
    });
    filterInput.dispatchEvent(new Event("change"));
  });
  filterInput.addEventListener("change", () => { void loadRiderJobs(true); });
  document.querySelector("#my-jobs-more").addEventListener("click", () => { void loadRiderJobs(false); });
  document.querySelector("#my-jobs-retry").addEventListener("click", () => { void loadRiderJobs(true); });
  client.channel(`my-rider-jobs-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "rider_jobs", filter: `assigned_rider=eq.${profile.id}`
  }, () => {
    void loadRiderJobs(true);
    periodSelect.dispatchEvent(new Event("change"));
  }).subscribe();
  await loadRiderJobs(true);
  startVisibleRefresh(() => loadRiderJobs(true), {
    intervalMs: 60000,
    visibilityMinAgeMs: 60000,
    lastRefreshAt: () => riderJobsLastLoadedAt
  });
  const openId = new URLSearchParams(location.search).get("open");
  if (openId && !riderJobRows.some((row) => row.id === openId)) {
    const { data, error } = await client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at")
      .eq("id", openId).maybeSingle();
    if (error) throw error;
    if (data) {
      riderJobRows.push(data);
      renderMyJobs();
    }
  }
}

