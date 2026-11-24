import { client } from "../core/supabase-client.js";
import { startVisibleRefresh } from "../core/visible-refresh.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { bindEditorKeyboard } from "../ui/dialog-keyboard.js";
import { initializeScrollableTables, initializeScrollableTableRow } from "../ui/scrollable-table.js";
import { sortRows, updateSortIndicators, bindSortableHeaders, setActiveSort } from "../ui/table-sort.js";
import { renderStatusChipButtons } from "../ui/status-chips.js";
import { escapeHtml } from "../utils/escape-html.js";
import { debounce } from "../utils/debounce.js";
import { today, dateKey, localDate, localDateTime } from "../utils/dates.js";
import { brandingModes } from "../utils/branding.js";
import { deliverySlotOptions, deliverySlotLabel, currentNairobiTime, hourlySlots } from "../utils/delivery-slots.js";
import { deliverySoNumbers, deliveryAddress, deliveryMissingAddress, deliveryAddressUrgent, deliveryGoodsStatusLabel, deliveryGoodsStatus, deliveryProductionStatusMarkup, deliveryDispatchStatusMarkup } from "../utils/delivery-rows.js";
import { activityPeriodDetail, activityPeriodSummary, activityPeriodType, activityQuery, bindPeriodSummary, renderActivityReport, renderPeriodSummary } from "./activity-panel.js";
import { hasDispatchAccess, hasProductionAccess, hasProductionStoreAccess } from "../portal.js";

let profile;
let page;

const DEFAULT_GOODS_FILTER = "pending";
const DELIVERY_ROLE_STATUS_LABELS = {
  production: [
    { value: "pending", label: "Pending", style: "pending" },
    { value: "Ready", label: "Ready", style: "ready" },
    { value: "all", label: "All", style: "all" }
  ],
  dispatch: [
    { value: "pending", label: "Pending", style: "pending" },
    { value: "Delivered", label: "Delivered", style: "ready" },
    { value: "all", label: "All", style: "all" }
  ]
};
let deliveryRows = [];
let deliveryRoleStatusFilter = "pending";
let deliveryUrgentFilter = false;
let productionGoodsFilter = DEFAULT_GOODS_FILTER;
let deliveryBrandingFilter = "all";
let assignedPendingDeliveries = [];
let urgentDeliveryRows = [];
const deliveryPopupShownKeys = new Set();
let urgentPopupLastShownAt = 0;
let deliveryRealtimeTimer = null;
let deliveryRealtimeIds = new Set();
let deliveryRowsVersion = 0;
let deliveryExitingRows = new Map();
let deliveryRefreshToken = 0;
let deliveryLastFullRefreshAt = 0;
let vehicleRows = [];
let deliveryQueryToken = 0;
let deliveryItemsState = { initial: [], lines: [] };
let deliveryEditId = null;
let productionEditId = null;
let productionEditOriginalQuantities = new Map();
let productionEditOriginalGoodsStatuses = new Map();
let productionEditCanChangeTotal = false;
let productionItemProgressByKey = new Map();
let productionRequestProgressById = new Map();
let productionLatestReleaseByKey = new Map();
let dispatchItemProgressByDelivery = new Map();
let dispatchRequestProgressById = new Map();
let dispatchTripsByDelivery = new Map();
let dispatchTripItemsByTripId = new Map();
let dispatchDialogState = { deliveryId: null, selectedTripId: "new", vehicle: "", riderId: "", note: "" };
let deliveryOriginalItemPairs = null;
let deliveryItemCheckSequence = 0;
let deliveryHardConflicts = [];
let deliveryConflictLineIndex = 0;
let deliverySoftWarningsSeen = new Set();
let deliveryDuplicateDialog = null;
let deliveryDuplicateReturnFocus = null;
let deliveryDuplicateAcknowledge = [];
let deliveryClientDefaults = { client: "", contacts: [], addresses: [] };
let deliveryClientSuggestionsTimer = null;
let deliveryAutofilledContactName = "";
let deliveryAutofilledContactNumber = "";
let deliveryAutofilledAddressLines = new WeakSet();

let deliveryActivityPeriod = { type: "day", date: "", dates: [], month: "" };
async function deliveryActivityRows(period, card) {
  const rows = [];
  const columns = "id,created_by,salesperson_id,client_name,items,delivery_date,production_status,dispatch_status,ready_at,dispatched_at";
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await activityQuery(deliveryReadTable(), period, card, columns)
      .order("delivery_date", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) {
      return rows.sort((left, right) =>
        String(left.delivery_date || "").localeCompare(String(right.delivery_date || "")));
    }
  }
}

function deliveryActivityItemText(items) {
  if (!Array.isArray(items) || !items.length) return "-";
  return items.map((item) => {
    const name = String(item.item_name || "").trim();
    const quantity = item.quantity ? ` × ${item.quantity} pcs` : "";
    return `${name}${quantity}`.trim() || "-";
  }).join(", ");
}

function renderDeliveryActivityRows(rows) {
  return rows.map((row) => {
    const salesperson = deliverySalespersonName(row);
    const salesOrders = deliverySoNumbers(row).join(", ") || "-";
    return `<tr><td>${escapeHtml(localDate(row.delivery_date) === "—" ? "-" : localDate(row.delivery_date))}</td><td>${escapeHtml(salesperson)}</td><td>${escapeHtml(salesOrders)}</td><td>${escapeHtml(row.client_name || "-")}</td><td>${escapeHtml(deliveryActivityItemText(row.items))}</td><td>${deliveryProductionStatusMarkup(row, "-")}</td><td>${deliveryDispatchStatusMarkup(row, "-")}</td></tr>`;
  }).join("");
}

async function openDeliveryActivity(card, period) {
  const dialog = document.querySelector("#delivery-activity-dialog");
  const requestId = Number(dialog.dataset.requestId || 0) + 1;
  dialog.dataset.requestId = String(requestId);
  const weekDates = activityPeriodType(period) === "week" ? [...new Set(period.dates || [])] : [];
  const periodTitle = weekDates.length ? `${weekDates.length} selected days` : activityPeriodSummary(period, true);
  const title = `${card.label}: ${periodTitle}`;
  const range = activityPeriodDetail(period);
  const printed = localDateTime(new Date());
  renderActivityReport({ title, range, total: 0, printed, message: "Loading deliveries…", rows: "" });
  if (!dialog.open) dialog.showModal();
  try {
    const rows = await deliveryActivityRows(period, card);
    if (!dialog.open || Number(dialog.dataset.requestId) !== requestId
      || JSON.stringify(deliveryActivityPeriod) !== JSON.stringify(period)) return;
    renderActivityReport({
      title,
      range,
      total: rows.length,
      printed,
      message: rows.length ? "" : "No deliveries for this period.",
      rows: renderDeliveryActivityRows(rows)
    });
  } catch {
    if (!dialog.open || Number(dialog.dataset.requestId) !== requestId) return;
    renderActivityReport({
      title,
      range,
      total: 0,
      printed,
      message: "Could not load deliveries for this period.",
      rows: ""
    });
  }
}

function updateDeliveryPeriodDisplay(period) {
  const type = activityPeriodType(period);
  const typeLabel = type[0].toUpperCase() + type.slice(1);
  const month = typeof period === "object" && period.month
    ? period.month : dateKey(today).slice(0, 7);
  const monthLabel = new Intl.DateTimeFormat("en", {
    month: "long", year: "numeric", timeZone: "Africa/Nairobi"
  }).format(new Date(`${month}-01T12:00:00+03:00`));
  const summary = type === "month" ? monthLabel : activityPeriodSummary(period, true);
  document.querySelector("#delivery-period").value = `${typeLabel} · ${summary}`;
}

function renderDeliveryPeriodCalendar(body, draft, viewMonth) {
  body.replaceChildren();
  const [year, month] = viewMonth.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const calendar = document.createElement("div");
  calendar.className = "delivery-period-calendar";
  const header = document.createElement("div");
  header.className = "delivery-period-calendar-heading";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "quiet";
  previous.dataset.calendarNav = "-1";
  previous.setAttribute("aria-label", "Previous month");
  previous.textContent = "‹";
  const monthLabel = document.createElement("strong");
  monthLabel.textContent = new Intl.DateTimeFormat("en", {
    month: "long", year: "numeric", timeZone: "UTC"
  }).format(first);
  const next = document.createElement("button");
  next.type = "button";
  next.className = "quiet";
  next.dataset.calendarNav = "1";
  next.setAttribute("aria-label", "Next month");
  next.textContent = "›";
  header.append(previous, monthLabel, next);
  const weekdays = document.createElement("div");
  weekdays.className = "delivery-period-weekdays";
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((day) => {
    const label = document.createElement("span");
    label.textContent = day;
    weekdays.append(label);
  });
  const days = document.createElement("div");
  days.className = "delivery-period-days";
  const selectedDates = new Set(draft.type === "day"
    ? [draft.date].filter(Boolean) : draft.dates);
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10);
    const day = document.createElement("button");
    day.type = "button";
    day.className = "delivery-period-day";
    if (key.slice(0, 7) !== viewMonth) day.classList.add("is-outside-month");
    day.dataset.calendarDay = key;
    day.id = `delivery-period-day-${key}`;
    day.setAttribute("aria-label", localDate(key));
    const selected = selectedDates.has(key);
    day.setAttribute("aria-pressed", String(selected));
    if (selected) day.classList.add("is-selected");
    if (key === dateKey(today)) day.setAttribute("aria-current", "date");
    day.textContent = String(date.getUTCDate());
    days.append(day);
  }
  calendar.append(header, weekdays, days);
  body.append(calendar);
}

function setupDeliveryPeriodPicker(onApply) {
  const input = document.querySelector("#delivery-period");
  const control = input.closest(".delivery-period-control");
  const icon = control.querySelector(".delivery-period-icon");
  const popover = control.querySelector("#delivery-period-popover");
  const body = control.querySelector("#delivery-period-picker-body");
  const typeButtons = [...control.querySelectorAll("[data-period-type]")];
  let draft = { ...deliveryActivityPeriod, dates: [...deliveryActivityPeriod.dates] };
  let viewMonth = dateKey(today).slice(0, 7);
  const setOpen = (open) => {
    popover.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    icon.setAttribute("aria-expanded", String(open));
    if (open) {
      draft = { ...deliveryActivityPeriod, dates: [...deliveryActivityPeriod.dates] };
      viewMonth = draft.type === "month" && draft.month ? draft.month
        : draft.type === "day" && draft.date ? draft.date.slice(0, 7)
          : draft.type === "week" && draft.dates.length ? draft.dates[0].slice(0, 7)
            : dateKey(today).slice(0, 7);
      render();
    } else {
      updateDeliveryPeriodDisplay(deliveryActivityPeriod);
    }
  };
  const updateTypeButtons = () => typeButtons.forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.periodType === draft.type)));
  const render = () => {
    updateTypeButtons();
    body.replaceChildren();
    if (draft.type === "month") {
      const monthInput = document.createElement("input");
      monthInput.type = "month";
      monthInput.value = draft.month || dateKey(today).slice(0, 7);
      monthInput.classList.toggle("is-selected", Boolean(draft.month));
      monthInput.setAttribute("aria-label", "Choose month and year");
      monthInput.addEventListener("input", () => {
        draft.month = monthInput.value;
        monthInput.classList.toggle("is-selected", Boolean(draft.month));
        updateDeliveryPeriodDisplay(draft);
      });
      body.append(monthInput);
    } else {
      renderDeliveryPeriodCalendar(body, draft, viewMonth);
    }
    updateDeliveryPeriodDisplay(draft);
  };
  const selectType = (type) => {
    draft = { type, date: "", dates: [], month: "" };
    viewMonth = dateKey(today).slice(0, 7);
    render();
  };
  const apply = () => {
    deliveryActivityPeriod = { ...draft, dates: [...draft.dates] };
    updateDeliveryPeriodDisplay(deliveryActivityPeriod);
    setOpen(false);
    onApply();
  };
  input.value = "";
  updateDeliveryPeriodDisplay(deliveryActivityPeriod);
  input.addEventListener("click", () => setOpen(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  });
  icon.addEventListener("click", () => setOpen(popover.hidden));
  typeButtons.forEach((button, index) => {
    button.addEventListener("click", () => selectType(button.dataset.periodType));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : typeButtons.length - 1)) % typeButtons.length;
      typeButtons[next].focus();
      selectType(typeButtons[next].dataset.periodType);
    });
  });
  body.addEventListener("click", (event) => {
    const navigation = event.target.closest("[data-calendar-nav]");
    if (navigation) {
      const date = new Date(`${viewMonth}-01T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + Number(navigation.dataset.calendarNav));
      viewMonth = date.toISOString().slice(0, 7);
      render();
      return;
    }
    const dayButton = event.target.closest("[data-calendar-day]");
    if (!dayButton) return;
    const date = dayButton.dataset.calendarDay;
    if (draft.type === "day") draft.date = date;
    else {
      const dates = new Set(draft.dates);
      if (dates.has(date)) dates.delete(date);
      else dates.add(date);
      draft.dates = [...dates].sort();
    }
    if (date.slice(0, 7) !== viewMonth) viewMonth = date.slice(0, 7);
    render();
    body.querySelector(`#delivery-period-day-${date}`)?.focus();
  });
  body.addEventListener("keydown", (event) => {
    const dayButton = event.target.closest("[data-calendar-day]");
    if (!dayButton || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const date = new Date(`${dayButton.dataset.calendarDay}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsets[event.key]);
    const target = date.toISOString().slice(0, 10);
    viewMonth = target.slice(0, 7);
    render();
    body.querySelector(`#delivery-period-day-${target}`)?.focus();
  });
  control.querySelector("#delivery-period-clear").addEventListener("click", () => {
    draft = { type: draft.type, date: "", dates: [], month: "" };
    apply();
  });
  control.querySelector("#delivery-period-apply").addEventListener("click", apply);
  document.addEventListener("pointerdown", (event) => {
    if (!popover.hidden && !control.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      event.stopPropagation();
      setOpen(false);
    }
  });
}


const SO_NUMBER_PREFIX = "SO-";


function hasSoNumber(value) {
  return String(value ?? "").trim().replace(/^SO-/i, "").trim().length > 0;
}

function normalizeSoToken(value) {
  const original = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!original) return "";
  const compact = original.toUpperCase().replace(/[\s._-]/g, "").replace(/^SO/, "");
  const match = compact.match(/^([A-Z]?)(\d+)([A-Z]{0,2})$/);
  return match
    ? `SO-${match[1]}${match[2]}${match[3] ? `-${match[3]}` : ""}`
    : original.toUpperCase();
}

function normalizeSoNumber(value) {
  const seen = new Set();
  return String(value ?? "").split(",").map((token) => normalizeSoToken(token))
    .filter((token) => token && !seen.has(token) && seen.add(token)).join(", ");
}

function soTokenNeedsFormat(value) {
  const token = String(value ?? "").trim();
  if (!token || /^SO-?$/i.test(token)) return false;
  const compact = token.toUpperCase().replace(/[\s._-]/g, "").replace(/^SO/, "");
  return !/^([A-Z]?)(\d+)([A-Z]{0,2})$/.test(compact);
}

function deliveryItemKey(value) {
  return String(value ?? "").toLowerCase().trim().replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((word) => {
      if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
      if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
      if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
      return word;
    }).join("");
}

function deliveryLinePairs(lines) {
  return lines.flatMap((line, lineIndex) => {
    const itemName = String(line.item_name ?? "").trim();
    const key = deliveryItemKey(itemName);
    if (!key) return [];
    return normalizeSoNumber(line.so_number).split(", ").filter(Boolean)
        .filter(hasSoNumber)
        .map((so) => ({ so, item_name: itemName, item_key: key, lineIndex }));
  });
}

function snapshotDeliveryItemPairs(lines) {
  const counts = new Map();
  lines.forEach((line) => {
    const itemName = String(line.item_name ?? "").trim().toLowerCase();
    if (!itemName) return;
    String(line.so_number ?? "").split(",").forEach((token) => {
      const so = token.trim().toUpperCase();
      if (!so || !hasSoNumber(so)) return;
      const key = `${so}\u0000${itemName}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return counts;
}



const deliverySelect = "id,sr,ref_no,created_at,created_by,salesperson_id,handoff_status,goods_status,client_name,contact_name,contact_number,items,delivery_time,delivery_time_any,delivery_date,special_instruction,production_status,dispatch_status,ready_at,dispatched_at,delivered_at,transport,vehicle_id";
const DELIVERY_FILTERS_KEY = "deliveryFilters";
const DELIVERY_REFERENCE_CACHE_TTL_MS = 10 * 60 * 1000;
let deliverySalespersonNames = new Map();
let activeDeliverySalespeople = null;
let activeDeliverySalespeopleFetchedAt = 0;
let activeDeliveryVehiclesFetchedAt = 0;
const deliveryProfileCache = new Map();
const deliveryVehicleNameCache = new Map();

function isProductionStoreMode() {
  return page === "production-store.html";
}

function canManageProductionReleases() {
  return profile?.role === "admin" || hasProductionStoreAccess(profile);
}

function productionProgressKey(deliveryId, itemKey) {
  return `${deliveryId}\u0000${itemKey}`;
}

function productionItemProgress(deliveryId, itemKey) {
  return itemKey ? productionItemProgressByKey.get(productionProgressKey(deliveryId, itemKey)) || null : null;
}

function isDispatchScreen() {
  return page === "deliveries.html" && (profile?.role === "admin" || hasDispatchAccess(profile));
}

function dispatchRequestProgress(deliveryId) {
  return dispatchRequestProgressById.get(deliveryId) || null;
}

function dispatchItemProgress(deliveryId, itemKey) {
  return (dispatchItemProgressByDelivery.get(deliveryId) || [])
    .find((item) => item.item_key === itemKey) || null;
}

function dispatchProgressSignature(deliveryId) {
  const trips = dispatchTripsByDelivery.get(deliveryId) || [];
  return JSON.stringify([
    dispatchRequestProgress(deliveryId),
    dispatchItemProgressByDelivery.get(deliveryId) || [],
    trips,
    ...trips.map((trip) => dispatchTripItemsByTripId.get(trip.id) || [])
  ]);
}

async function loadDispatchProgress(deliveryIds, replaceAll = false) {
  if (!isDispatchScreen()) return new Set();
  const ids = [...new Set(deliveryIds)];
  const previous = new Map(ids.map((id) => [id, dispatchProgressSignature(id)]));
  if (replaceAll) {
    dispatchItemProgressByDelivery.clear();
    dispatchRequestProgressById.clear();
    dispatchTripsByDelivery.clear();
    dispatchTripItemsByTripId.clear();
  } else {
    for (const id of ids) {
      const oldTrips = dispatchTripsByDelivery.get(id) || [];
      oldTrips.forEach((trip) => dispatchTripItemsByTripId.delete(trip.id));
      dispatchItemProgressByDelivery.delete(id);
      dispatchRequestProgressById.delete(id);
      dispatchTripsByDelivery.delete(id);
    }
  }
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    if (!batch.length) continue;
    const [itemResult, requestResult, tripResult, tripItemResult] = await Promise.all([
      client.from("delivery_item_progress")
        .select("delivery_id,item_key,item_name,so_number,job_card_total,released,received,in_production,packed,delivered,available_to_receive,available_to_pack")
        .in("delivery_id", batch),
      client.from("delivery_request_progress")
        .select("delivery_id,job_card_total,released,received,in_production,packed,delivered,available_to_receive,available_to_pack,balance,goods_status,production_state,dispatch_state,board_stage")
        .in("delivery_id", batch),
      client.from("dispatch_trips")
        .select("id,delivery_id,vehicle,rider_id,status,delivered_on,delivery_address,note,voided_at")
        .in("delivery_id", batch)
        .order("created_at", { ascending: false }),
      client.from("dispatch_trip_items")
        .select("id,trip_id,delivery_id,item_key,qty_packed,qty_delivered")
        .in("delivery_id", batch)
    ]);
    for (const result of [itemResult, requestResult, tripResult, tripItemResult]) {
      if (result.error) throw result.error;
    }
    for (const item of itemResult.data || []) {
      const lines = dispatchItemProgressByDelivery.get(item.delivery_id) || [];
      lines.push(item);
      dispatchItemProgressByDelivery.set(item.delivery_id, lines);
    }
    for (const request of requestResult.data || []) {
      dispatchRequestProgressById.set(request.delivery_id, request);
    }
    for (const trip of tripResult.data || []) {
      const trips = dispatchTripsByDelivery.get(trip.delivery_id) || [];
      trips.push(trip);
      dispatchTripsByDelivery.set(trip.delivery_id, trips);
    }
    for (const item of tripItemResult.data || []) {
      const items = dispatchTripItemsByTripId.get(item.trip_id) || [];
      items.push(item);
      dispatchTripItemsByTripId.set(item.trip_id, items);
    }
  }
  return new Set(ids.filter((id) => previous.get(id) !== dispatchProgressSignature(id)));
}

function productionRequestGoodsStatus(row) {
  const status = productionRequestProgressById.get(row.id)?.goods_status;
  return ({ "Ready": "ready", "Partially ready": "partial", "Not ready": "not_ready" })[status] || "";
}

function currentDeliveryGoodsStatus(row) {
  return isProductionStoreMode() ? productionRequestGoodsStatus(row) : deliveryGoodsStatus(row);
}

function productionProgressSignature(deliveryId) {
  const row = deliveryRows.find((delivery) => delivery.id === deliveryId);
  const items = Array.isArray(row?.items) ? row.items : [];
  return JSON.stringify([
    productionRequestProgressById.get(deliveryId) || null,
    ...items.map((item) => productionItemProgress(deliveryId, item.item_key)),
    ...items.map((item) => productionLatestReleaseByKey.get(productionProgressKey(deliveryId, item.item_key)) || null)
  ]);
}

async function loadProductionStoreProgress(deliveryIds, replaceAll = false) {
  if (!isProductionStoreMode()) return new Set();
  const uniqueIds = [...new Set(deliveryIds)];
  const previous = new Map(uniqueIds.map((id) => [id, productionProgressSignature(id)]));
  if (replaceAll) {
    productionItemProgressByKey.clear();
    productionRequestProgressById.clear();
    productionLatestReleaseByKey.clear();
  } else {
    uniqueIds.forEach((id) => productionRequestProgressById.delete(id));
    for (const key of productionItemProgressByKey.keys()) {
      if (uniqueIds.some((id) => key.startsWith(`${id}\u0000`))) productionItemProgressByKey.delete(key);
    }
    for (const key of productionLatestReleaseByKey.keys()) {
      if (uniqueIds.some((id) => key.startsWith(`${id}\u0000`))) productionLatestReleaseByKey.delete(key);
    }
  }
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const batch = uniqueIds.slice(index, index + 100);
    const [itemResult, requestResult, releaseResult] = await Promise.all([
      client.from("delivery_item_progress")
        .select("delivery_id,item_key,job_card_total,released,available_to_release")
        .in("delivery_id", batch),
      client.from("delivery_request_progress")
        .select("delivery_id,job_card_total,released,received,in_production,packed,delivered,available_to_release,available_to_receive,available_to_pack,balance,goods_status,production_state,dispatch_state,board_stage")
        .in("delivery_id", batch),
      client.from("store_release_logs")
        .select("delivery_id,item_key,qty,done_on,created_at,voided_at")
        .in("delivery_id", batch)
        .order("created_at", { ascending: false })
    ]);
    if (itemResult.error) throw itemResult.error;
    if (requestResult.error) throw requestResult.error;
    if (releaseResult.error) throw releaseResult.error;
    for (const item of itemResult.data || []) {
      productionItemProgressByKey.set(productionProgressKey(item.delivery_id, item.item_key), item);
    }
    for (const request of requestResult.data || []) {
      productionRequestProgressById.set(request.delivery_id, request);
    }
    for (const release of releaseResult.data || []) {
      const key = productionProgressKey(release.delivery_id, release.item_key);
      if (!release.voided_at && !productionLatestReleaseByKey.has(key)) {
        productionLatestReleaseByKey.set(key, release);
      }
    }
  }
  return new Set(uniqueIds.filter((id) => previous.get(id) !== productionProgressSignature(id)));
}

export function initializeDeliveryStickyScrollbar() {
  const scrollbar = document.querySelector("#delivery-table-sticky-scrollbar");
  const wrapper = document.querySelector("#deliveries-table")?.closest(".table-wrap");
  const table = document.querySelector("#deliveries-table");
  const inner = scrollbar?.firstElementChild;
  if (!scrollbar || !wrapper || !table || !inner) return;
  const update = () => {
    const rect = wrapper.getBoundingClientRect();
    const hasOverflow = window.innerWidth >= 768 && table.scrollWidth > wrapper.clientWidth + 1;
    scrollbar.style.display = hasOverflow ? "block" : "none";
    scrollbar.style.left = `${rect.left}px`;
    scrollbar.style.width = `${rect.width}px`;
    inner.style.width = `${table.scrollWidth}px`;
    if (scrollbar.scrollLeft !== wrapper.scrollLeft) scrollbar.scrollLeft = wrapper.scrollLeft;
  };
  if (scrollbar.dataset.bound !== "true") {
    scrollbar.dataset.bound = "true";
    scrollbar.addEventListener("scroll", () => {
      if (wrapper.scrollLeft !== scrollbar.scrollLeft) wrapper.scrollLeft = scrollbar.scrollLeft;
    }, { passive: true });
    wrapper.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
  }
  update();
}

function deliveryReadTable() {
  return !isProductionStoreMode() && (hasProductionAccess(profile) || hasDispatchAccess(profile))
    ? "deliveries_role_safe" : "deliveries";
}

function configureDeliveryForm(form, productionEntry = false) {
  ["client_name", "contact_name", "contact_number", "delivery_date", "delivery_time"].forEach((name) => {
    form.elements[name].required = !productionEntry;
  });
  if (form.elements.salesperson_id) form.elements.salesperson_id.required = productionEntry;
}

function deliveryItemSummary(items) {
  const lines = Array.isArray(items) ? items : [];
  if (!lines.length) return "—";
  const first = `${escapeHtml(lines[0].item_name)}${lines[0].quantity ? ` × ${escapeHtml(lines[0].quantity)} pcs` : ""}`;
  return `${first}${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`;
}

function dispatchItemsSummary(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return items.length ? items.map((item) => {
    const progress = dispatchItemProgress(row.id, item.item_key);
    const status = progress
      ? `Received ${progress.received}/${progress.job_card_total} · In production ${progress.in_production} · Packed ${progress.packed} · Delivered ${progress.delivered}`
      : "Progress unavailable";
    return `<div>${escapeHtml(item.so_number || "—")} · ${escapeHtml(item.item_name || "Item")} · ${escapeHtml(status)}</div>`;
  }).join("") : "—";
}

function productionLatestReleaseLabel(deliveryId, itemKey) {
  const release = itemKey ? productionLatestReleaseByKey.get(productionProgressKey(deliveryId, itemKey)) : null;
  return release ? `${localDate(release.done_on)} · ${release.qty}` : "—";
}

function productionStoreItemSummary(items, deliveryId = null) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const progress = deliveryId && item.item_key ? productionItemProgress(deliveryId, item.item_key) : null;
    return `${item.item_name || "Item"} ${progress ? `${progress.released}/${progress.job_card_total}` : "—/—"}`;
  }).join(", ") || "Click to add item details";
}

function deliveryDetailsNeeded(row) {
  return deliveryMissingAddress(row)
    && row.dispatch_status !== "Delivered"
    && !row.delivered_at;
}

function deliverySalespersonName(row) {
  return deliverySalespersonNames.get(row.salesperson_id || row.created_by) || "—";
}

function deliverySoNumberCell(row) {
  const numbers = deliverySoNumbers(row);
  if (!numbers.length) return "—";
  const visible = numbers.slice(0, 2).map(escapeHtml).join(", ");
  const remaining = numbers.length > 2 ? ` +${numbers.length - 2} more` : "";
  return `<span class="delivery-so-numbers" title="${escapeHtml(numbers.join(", "))}">${visible}${remaining}</span>`;
}

function deliveryBrandingModes(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return [...new Set(items.flatMap((item) => String(item.branding_mode || "").split(",").map((mode) => mode.trim()).filter(Boolean)))];
}

function setDeliveryBrandingSelection(form, modes) {
  const root = form.querySelector("[data-branding-multiselect]");
  const selected = brandingModes.filter((mode) => modes.includes(mode));
  form.elements.branding_modes.value = selected.join(", ");
  const chips = root.querySelector("[data-branding-chips]");
  chips.replaceChildren();
  if (!selected.length) {
    const placeholder = document.createElement("span");
    placeholder.className = "branding-picker-placeholder";
    placeholder.textContent = "Select modes...";
    chips.append(placeholder);
  }
  selected.forEach((mode) => {
    const chip = document.createElement("span");
    chip.className = "branding-picker-chip";
    chip.textContent = mode;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "branding-picker-chip-remove";
    remove.setAttribute("aria-label", `Remove ${mode}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      setDeliveryBrandingSelection(form, selected.filter((item) => item !== mode));
      root.querySelector(`[data-branding-mode="${CSS.escape(mode)}"]`).checked = false;
    });
    chip.append(remove);
    chips.append(chip);
  });
  root.querySelector("[data-branding-clear]").hidden = !selected.length;
  root.querySelectorAll("[data-branding-mode]").forEach((input) => {
    input.checked = selected.includes(input.value);
  });
}

function setupDeliveryBrandingPicker(form) {
  const root = form.querySelector("[data-branding-multiselect]");
  const control = root.querySelector("[data-branding-toggle]");
  const options = root.querySelector("[data-branding-options]");
  const close = () => {
    options.hidden = true;
    control.setAttribute("aria-expanded", "false");
  };
  const toggle = () => {
    options.hidden = !options.hidden;
    control.setAttribute("aria-expanded", String(!options.hidden));
  };
  options.replaceChildren(...brandingModes.map((mode) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = mode;
    checkbox.dataset.brandingMode = "";
    checkbox.setAttribute("aria-label", mode);
    checkbox.addEventListener("change", () => {
      const selected = brandingModes.filter((item) => root.querySelector(`[data-branding-mode][value="${CSS.escape(item)}"]`).checked);
      setDeliveryBrandingSelection(form, selected);
    });
    label.append(checkbox, document.createTextNode(mode));
    return label;
  }));
  root.addEventListener("click", (event) => {
    if (options.contains(event.target) || event.target.closest("[data-branding-clear], .branding-picker-chip-remove")) return;
    toggle();
  });
  root.querySelector("[data-branding-clear]").addEventListener("click", (event) => {
    event.stopPropagation();
    setDeliveryBrandingSelection(form, []);
  });
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  options.addEventListener("keydown", (event) => {
    const checkboxes = [...options.querySelectorAll("[data-branding-mode]")];
    const index = checkboxes.indexOf(event.target);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      checkboxes[(index + direction + checkboxes.length) % checkboxes.length].focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.target.checked = !event.target.checked;
      event.target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || options.hidden) return;
    event.preventDefault();
    close();
    control.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) close();
  });
  setDeliveryBrandingSelection(form, []);
}

function updateDeliverySlotOptions() {
  const form = document.querySelector("#delivery-request-form");
  const select = form?.elements.delivery_time;
  if (!select) return;
  const date = form.elements.delivery_date.value;
  const selected = select.value;
  const current = date === today ? currentNairobiTime() : "";
  select.innerHTML = '<option value="">Choose hourly slot</option><option value="any">Any time</option>' + deliverySlotOptions(date, today, current).map((slot) =>
    `<option value="${slot.start}"${slot.disabled ? " disabled" : ""}>${escapeHtml(slot.label)}</option>`
  ).join("");
  if ([...select.options].some((option) => option.value === selected && !option.disabled)) select.value = selected;
}

function renderItemLineEditor() {
  const root = document.querySelector("#delivery-item-lines");
  root.replaceChildren();
  const compactProductionEdit = isProductionStoreMode() && Boolean(productionEditId);
  document.querySelector("#delivery-item-add").hidden = compactProductionEdit;
  if (compactProductionEdit) {
    const table = document.createElement("table");
    table.className = "production-item-details-table";
    table.style.width = "100%";
    table.style.minWidth = "0";
    const header = table.createTHead().insertRow();
    header.insertCell().textContent = "SO number";
    header.insertCell().textContent = "Item details";
    const body = table.createTBody();
    deliveryItemsState.lines.forEach((line) => {
      const row = body.insertRow();
      row.insertCell().textContent = line.so_number || "—";
      const details = row.insertCell();
      const progress = productionItemProgress(productionEditId, line.item_key);
      const description = document.createElement("p");
      description.textContent = `${line.item_name || "Item"} ${progress ? `${progress.released}/${progress.job_card_total}` : "—/—"}`;
      const label = document.createElement("label");
      label.textContent = "Goods status";
      const select = document.createElement("select");
      select.name = "goods_status";
      select.innerHTML = '<option value="">Choose action</option><option value="ready">Ready</option><option value="partial">Partially ready</option><option value="not_ready">Not ready</option>';
      select.value = line.goods_status || "";
      select.addEventListener("change", () => {
        line.goods_status = select.value;
      });
      label.append(select);
      details.append(description, label);
    });
    root.append(table);
    return;
  }
  const productionEntry = isProductionStoreMode() && !deliveryEditId && !productionEditId;
  deliveryItemsState.lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "delivery-item-row";
    row.dataset.shortcutRow = "";
    const fields = [
      ["so_number", "SO number", "text"],
      ["item_name", "Item name", "text"],
      ["quantity", "Quantity (pcs)", "number"],
      ["address", "Address to deliver", "text"]
    ];
    for (const [name, labelText, type] of fields) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.name = name;
      input.type = type;
      input.required = isProductionStoreMode()
        ? name === "item_name" || name === "quantity"
        : true;
      if (name !== "address" && !(isProductionStoreMode() && name === "quantity")) {
        input.maxLength = type === "number" ? 5 : 200;
      }
      if (type === "number") {
        input.min = "1";
        input.step = "1";
        input.inputMode = "numeric";
      }
      if (name === "quantity" && productionEditId && !productionEditCanChangeTotal) input.readOnly = true;
      input.value = name === "so_number" && !line[name] ? SO_NUMBER_PREFIX : line[name] ?? "";
      if (name === "address" && !input.value && !deliveryEditId && !productionEditId) {
        const clientName = document.querySelector("#delivery-request-form").elements.client_name.value.trim();
        if (deliveryClientDefaults.client === clientName && deliveryClientDefaults.addresses.length) {
          line.address = deliveryClientDefaults.addresses[0];
          input.value = line.address;
          deliveryAutofilledAddressLines.add(line);
          const datalist = document.createElement("datalist");
          datalist.id = `delivery-address-suggestions-${index}`;
          deliveryClientDefaults.addresses.forEach((address) => {
            const option = document.createElement("option");
            option.value = address;
            datalist.append(option);
          });
          input.setAttribute("list", datalist.id);
          label.append(datalist);
        }
      }
      input.addEventListener("input", () => {
        line[name] = input.value;
        if (name === "address") deliveryAutofilledAddressLines.delete(line);
        input.classList.remove("field-error");
        if (name === "so_number" || name === "item_name") {
          clearDeliveryItemConflictState();
          if (name === "so_number") updateSoFormatHint(input, line);
        }
      });
      label.append(input);
      if (name === "so_number") {
        const formatHint = document.createElement("small");
        formatHint.className = "delivery-so-format-hint";
        label.append(formatHint);
        updateSoFormatHint(input, line);
        input.addEventListener("blur", () => {
          line.so_number = normalizeSoNumber(input.value);
          input.value = line.so_number;
          updateSoFormatHint(input, line);
          void checkDeliveryItemPairs(deliveryItemsState.lines, input);
        });
      } else if (name === "item_name") {
        input.addEventListener("blur", () => {
          void checkDeliveryItemPairs(deliveryItemsState.lines, input);
        });
      }
      row.append(label);
    }
    if (productionEntry || productionEditId || deliveryEditId || line.goods_status) {
      const label = document.createElement("label");
      label.textContent = "Goods status";
      const select = document.createElement("select");
      select.name = "goods_status";
      select.required = productionEntry;
      select.disabled = Boolean(deliveryEditId && line.goods_status);
      select.innerHTML = isProductionStoreMode()
        ? '<option value="">Choose action</option><option value="ready">Ready</option><option value="partial">Partially ready</option><option value="not_ready">Not ready</option>'
        : '<option value="">Choose goods status</option><option value="ready">Ready</option><option value="partial">Partially</option><option value="not_ready">Not ready</option>';
      select.value = productionEditId ? "" : line.goods_status || "";
      select.addEventListener("change", () => {
        line.goods_status = select.value;
        select.classList.remove("field-error");
      });
      label.append(select);
      row.append(label);
    }
    const issue = document.createElement("small");
    issue.className = "delivery-item-conflict-note";
    row.append(issue);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.shortcutRemove = "";
    remove.textContent = "Remove";
    remove.disabled = Boolean(productionEditId && !productionEditCanChangeTotal);
    remove.addEventListener("click", () => {
      clearDeliveryItemConflictState();
      if (deliveryItemsState.lines.length === 1) {
        deliveryItemsState.lines[0] = { so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "", goods_status: "" };
      } else {
        deliveryItemsState.lines.splice(index, 1);
      }
      renderItemLineEditor();
    });
    row.append(remove);
    root.append(row);
  });
}

function updateSoFormatHint(input, line) {
  const hint = input.parentElement.querySelector(".delivery-so-format-hint");
  if (!hint) return;
  const invalid = String(line.so_number ?? "").split(",").some(soTokenNeedsFormat);
  hint.textContent = invalid ? "SO number format is unusual; it will be saved as entered." : "";
  hint.hidden = !invalid;
}

function updateDeliverySubmitState() {
  const button = document.querySelector("#delivery-request-form [type='submit']");
  if (button) button.disabled = deliveryHardConflicts.length > 0;
}

function clearDeliveryItemConflictState() {
  deliveryItemCheckSequence += 1;
  deliveryHardConflicts = [];
  deliverySoftWarningsSeen = new Set();
  document.querySelectorAll("#delivery-item-lines .delivery-item-conflict-note").forEach((note) => {
    note.replaceChildren();
    note.hidden = true;
  });
  updateDeliverySubmitState();
}

function renderDeliveryLineIssue(entries, note) {
  const issue = note.querySelector(".delivery-item-conflict-note");
  issue.replaceChildren();
  issue.hidden = !entries?.length;
  if (!entries?.length) return;
  entries.forEach((entry, index) => {
    if (index) issue.append(document.createElement("br"));
    const text = document.createElement("span");
    text.className = entry.conflict_type === "hard" ? "is-hard" : "is-soft";
    text.textContent = entry.conflict_type === "hard"
      ? `Already filled${entry.sr ? `, see ${entry.sr}` : " on this request"}. `
      : `${entry.reason || "Similar item on another delivery."} `;
    issue.append(text);
    if (entry.can_view) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "delivery-conflict-more";
      more.textContent = "See more";
      more.addEventListener("click", () => showDeliveryConflictDialog([entry]));
      issue.append(more);
    }
  });
}

function ensureDeliveryDuplicateDialog() {
  if (deliveryDuplicateDialog?.isConnected) return deliveryDuplicateDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "line-editor-dialog delivery-duplicate-dialog";
  dialog.setAttribute("aria-labelledby", "delivery-duplicate-title");
  const content = document.createElement("div");
  content.className = "line-dialog-content";
  const heading = document.createElement("h2");
  heading.id = "delivery-duplicate-title";
  heading.textContent = "Delivery item check";
  const message = document.createElement("p");
  message.className = "delivery-duplicate-message";
  const list = document.createElement("div");
  list.className = "delivery-duplicate-list";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  actions.append(close);
  content.append(heading, message, list, actions);
  dialog.append(content);
  dialog.addEventListener("close", () => {
    deliveryDuplicateAcknowledge.forEach((key) => deliverySoftWarningsSeen.add(key));
    deliveryDuplicateAcknowledge = [];
    const focus = deliveryDuplicateReturnFocus;
    deliveryDuplicateReturnFocus = null;
    if (typeof focus === "function") focus();
    else if (focus?.isConnected) focus.focus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  deliveryDuplicateDialog = dialog;
  return dialog;
}

async function openDuplicateDelivery(conflict, dialog, trigger) {
  dialog.close();
  if (!conflict.delivery_id) return;
  let result;
  try {
    result = await client.from(deliveryReadTable())
      .select(deliverySelect).eq("id", conflict.delivery_id).maybeSingle();
  } catch (error) {
    toast(`Could not open the existing delivery: ${error.message || "unknown error"}`, "error");
    return;
  }
  const { data, error } = result;
  if (error) {
    toast(`Could not open the existing delivery: ${error.message || "unknown error"}`, "error");
    return;
  }
  if (!data) {
    toast("The existing delivery is not available to your account.", "error");
    return;
  }
  await openDeliveryView(data, trigger);
}

async function showDuplicateSaveConflict(so, itemKey, sr, returnFocus) {
  let conflict = {
    conflict_type: "hard",
    so,
    item_key: itemKey,
    sr,
    reason: "Already recorded",
    can_view: false
  };
  if (sr === "SAME_REQUEST") {
    showDeliveryConflictDialog([conflict], null, returnFocus);
    return;
  }
  let result;
  try {
    result = await client.from(deliveryReadTable())
      .select(deliverySelect).eq("sr", sr).maybeSingle();
  } catch (error) {
    toast(`Could not load the existing delivery summary: ${error.message || "unknown error"}`, "error");
  }
  const { data, error } = result || {};
  if (error) {
    toast(`Could not load the existing delivery summary: ${error.message || "unknown error"}`, "error");
  } else if (data) {
    conflict = {
      ...conflict,
      delivery_id: data.id,
      client_name: data.client_name,
      delivery_date: data.delivery_date,
      dispatch_status: data.dispatch_status,
      salesperson_name: deliverySalespersonNames.get(data.salesperson_id || data.created_by) || "",
      can_view: true
    };
  } else {
    let summaryResult;
    try {
      summaryResult = await client.rpc("check_so_items", {
        p_pairs: [{ so, item_name: itemKey, client_name: "" }],
        p_exclude_id: deliveryEditId || productionEditId || null
      });
    } catch (summaryError) {
      toast(`Could not load the existing delivery summary: ${summaryError.message || "unknown error"}`, "error");
    }
    const { data: summaries, error: summaryError } = summaryResult || {};
    if (summaryError) {
      toast(`Could not load the existing delivery summary: ${summaryError.message || "unknown error"}`, "error");
    } else {
      const summary = (summaries || []).find((entry) => entry.conflict_type === "hard" && entry.sr === sr);
      if (summary) conflict = summary;
    }
  }
  showDeliveryConflictDialog([conflict], null, returnFocus);
}

function showDeliveryConflictDialog(conflicts, focusTarget = null, returnFocus = focusTarget) {
  const dialog = ensureDeliveryDuplicateDialog();
  const message = dialog.querySelector(".delivery-duplicate-message");
  const list = dialog.querySelector(".delivery-duplicate-list");
  message.textContent = conflicts.some((conflict) => conflict.conflict_type === "hard")
    ? "This SO and item combination is already recorded. Update the item details before saving."
    : "Review similar delivery items before saving.";
  list.replaceChildren();
  conflicts.forEach((conflict) => {
    const entry = document.createElement("section");
    entry.className = "delivery-duplicate-entry";
    const title = document.createElement("strong");
    title.textContent = `${conflict.so || "SO —"} · ${conflict.item_key || "item —"}`;
    const summary = document.createElement("p");
    summary.textContent = [
      conflict.sr,
      conflict.client_name,
      conflict.delivery_date,
      conflict.dispatch_status,
      conflict.salesperson_name
    ].filter(Boolean).join(" · ") || (conflict.reason || "Same request");
    entry.append(title, summary);
    if (conflict.can_view && conflict.delivery_id) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "secondary";
      more.textContent = "See more";
      more.addEventListener("click", () => {
        deliveryDuplicateReturnFocus = null;
        void openDuplicateDelivery(conflict, dialog, more);
      });
      entry.append(more);
    }
    list.append(entry);
  });
  deliveryDuplicateAcknowledge = conflicts.filter((conflict) => conflict.conflict_type === "soft")
    .map(softConflictKey);
  deliveryDuplicateReturnFocus = returnFocus;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".dialog-actions button")?.focus();
}

function softConflictKey(conflict) {
  const clientName = document.querySelector("#delivery-request-form")?.elements.client_name.value.trim().toLowerCase() || "";
  return `${clientName}\u0000${conflict.so}\u0000${conflict.item_key}\u0000${conflict.reason || ""}`;
}

async function checkDeliveryItemPairs(lines, focusTarget = null, returnFocus = focusTarget, showSoftPopup = true, blockOnSoft = false) {
  const checkId = ++deliveryItemCheckSequence;
  const pairs = deliveryLinePairs(lines);
  const currentPairCounts = new Map();
  const checkPairs = pairs.filter((pair) => {
    const key = `${pair.so.trim().toUpperCase()}\u0000${pair.item_name.trim().toLowerCase()}`;
    const count = (currentPairCounts.get(key) || 0) + 1;
    currentPairCounts.set(key, count);
    return count > (deliveryOriginalItemPairs?.get(key) || 0);
  });
  const lineIssues = new Map();
  const hard = [];
  const localPairs = new Map();
  pairs.forEach((pair) => {
    const key = `${pair.so}\u0000${pair.item_key}`;
    const previous = localPairs.get(key);
    if (previous) {
      const conflict = {
        conflict_type: "hard",
        so: pair.so,
        item_key: pair.item_key,
        reason: "same_request",
        can_view: false
      };
      hard.push(conflict);
      [previous.lineIndex, pair.lineIndex].forEach((lineIndex) => {
        const issues = lineIssues.get(lineIndex) || [];
        if (!issues.some((entry) => entry.conflict_type === "hard" && entry.so === pair.so && entry.item_key === pair.item_key)) {
          issues.push(conflict);
          lineIssues.set(lineIndex, issues);
        }
      });
    } else {
      localPairs.set(key, pair);
    }
  });

  if (checkPairs.length) {
    const uniquePairs = [...new Map(checkPairs.map((pair) => [
      `${pair.so}\u0000${pair.item_key}`,
      { so: pair.so, item_name: pair.item_name, client_name: document.querySelector("#delivery-request-form").elements.client_name.value.trim() }
    ])).values()];
    let result;
    try {
      result = await client.rpc("check_so_items", {
        p_pairs: uniquePairs,
        p_exclude_id: deliveryEditId || productionEditId || null
      });
    } catch (error) {
      if (checkId === deliveryItemCheckSequence) {
        toast(`Could not check delivery items: ${error.message || "unknown error"}`, "error");
      }
      return false;
    }
    const { data, error } = result;
    if (checkId !== deliveryItemCheckSequence) return false;
    if (error) {
      toast(`Could not check delivery items: ${error.message || "unknown error"}`, "error");
      return false;
    }
    (data || []).forEach((conflict) => {
      const matchingPairs = checkPairs.filter((item) => item.so === conflict.so && item.item_key === conflict.item_key);
      if (!matchingPairs.length) return;
      matchingPairs.forEach((pair) => {
        const issues = lineIssues.get(pair.lineIndex) || [];
        issues.push(conflict);
        lineIssues.set(pair.lineIndex, issues);
      });
      if (conflict.conflict_type === "hard") hard.push(conflict);
    });
  }
  if (checkId !== deliveryItemCheckSequence) return false;

  deliveryHardConflicts = hard;
  lines.forEach((line, index) => {
    const issues = lineIssues.get(index) || [];
    const row = document.querySelectorAll("#delivery-item-lines .delivery-item-row")[index];
    if (row) renderDeliveryLineIssue(issues, row);
  });
  updateDeliverySubmitState();
  if (hard.length) {
    const uniqueHard = [...new Map(hard.map((conflict) => [
      `${conflict.so}\u0000${conflict.item_key}`, conflict
    ])).values()];
    const conflictingPair = checkPairs.find((pair) => pair.so === uniqueHard[0].so && pair.item_key === uniqueHard[0].item_key);
    deliveryConflictLineIndex = conflictingPair?.lineIndex ?? 0;
    const conflictingInput = document.querySelectorAll("#delivery-item-lines .delivery-item-row [name='so_number']")[deliveryConflictLineIndex];
    showDeliveryConflictDialog(uniqueHard, conflictingInput || focusTarget,
      returnFocus === focusTarget ? conflictingInput || focusTarget : returnFocus);
    return false;
  }
  const soft = [...lineIssues.values()].flat().filter((conflict) => conflict.conflict_type === "soft");
  const unseenSoft = soft.filter((conflict) => !deliverySoftWarningsSeen.has(softConflictKey(conflict)));
  if (unseenSoft.length && showSoftPopup) {
    const conflictingPair = checkPairs.find((pair) => pair.so === unseenSoft[0].so && pair.item_key === unseenSoft[0].item_key);
    deliveryConflictLineIndex = conflictingPair?.lineIndex ?? 0;
    const conflictingInput = document.querySelectorAll("#delivery-item-lines .delivery-item-row [name='so_number']")[deliveryConflictLineIndex];
    showDeliveryConflictDialog(unseenSoft, conflictingInput || focusTarget,
      returnFocus === focusTarget ? conflictingInput || focusTarget : returnFocus);
    if (blockOnSoft) return false;
  }
  return true;
}

function openDeliveryItems() {
  let parsed;
  try {
    parsed = JSON.parse(document.querySelector('[name="items"]').value || "[]");
  } catch {
    toast("Could not read saved item details.", "error");
    return;
  }
  const existing = Array.isArray(parsed) ? parsed : [];
  const editorLines = existing.map((line) => ({
    ...line,
    ...(productionEditId ? { goods_status: "" } : {})
  }));
  deliveryItemsState = {
    initial: editorLines.map((line) => ({ ...line })),
    lines: (editorLines.length ? editorLines : [{ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "", goods_status: "" }])
      .map((line) => ({ ...line }))
  };
  document.querySelector("#delivery-items-message").textContent = "";
  renderItemLineEditor();
  document.querySelector("#delivery-items-dialog").showModal();
  document.querySelector('#delivery-item-lines input')?.focus();
}

function clearDeliveryItemErrors() {
  document.querySelectorAll("#delivery-item-lines .field-error").forEach((input) => input.classList.remove("field-error"));
  document.querySelector("#delivery-items-message").textContent = "";
}

function closeDeliveryItems(discard = true) {
  const dialog = document.querySelector("#delivery-items-dialog");
  if (!dialog.open) return;
  if (discard && JSON.stringify(deliveryItemsState.lines) !== JSON.stringify(deliveryItemsState.initial)
    && !confirm("Discard unsaved item details?")) return;
  clearDeliveryItemErrors();
  dialog.close();
  document.querySelector("#delivery-items-open").focus();
}

function deliveryItemsMarkup(lines) {
  return lines.map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, String(value).trim()])));
}

function promptPartialReleases(partials) {
  const dialog = document.querySelector("#partial-release-dialog");
  const form = document.querySelector("#partial-release-form");
  const lines = document.querySelector("#partial-release-lines");
  const message = document.querySelector("#partial-release-message");
  lines.replaceChildren();
  const inputs = partials.map((partial, index) => {
    const line = document.createElement("div");
    line.className = "partial-release-line";
    const remaining = document.createElement("p");
    remaining.textContent = `${partial.itemName} · ${partial.available} remaining`;
    const label = document.createElement("label");
    label.textContent = "Released now?";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.required = true;
    input.name = `partial-release-${index}`;
    input.value = String(partial.available);
    input.setAttribute("aria-label", `Released now for ${partial.itemName}`);
    label.append(input);
    line.append(remaining, label);
    lines.append(line);
    return input;
  });
  message.textContent = "";
  dialog.showModal();
  inputs[0]?.focus();
  inputs[0]?.select();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", submit);
      dialog.removeEventListener("close", close);
      dialog.close();
      lines.replaceChildren();
      resolve(value);
    };
    const submit = (event) => {
      event.preventDefault();
      for (const input of inputs) {
        if (!/^[1-9]\d*$/.test(input.value.trim())) {
          message.textContent = "Enter a positive whole number for each item.";
          input.focus();
          return;
        }
      }
      finish(inputs.map((input) => Number(input.value)));
    };
    const close = () => finish(null);
    form.addEventListener("submit", submit);
    dialog.addEventListener("close", close);
  });
}

async function applyProductionReleaseIntents(deliveryId, savedItems, intents) {
  const items = Array.isArray(savedItems) ? savedItems : [];
  const { data: progressRows, error: progressError } = await client.from("delivery_item_progress")
    .select("delivery_id,item_key,available_to_release")
    .eq("delivery_id", deliveryId);
  if (progressError) throw progressError;
  const progressByKey = new Map((progressRows || []).map((item) => [item.item_key, item]));
  const prepared = intents.map((intent) => {
    const item = items[intent.index];
    if (!item?.item_key) throw new Error("Could not identify the saved item line for release.");
    const progress = progressByKey.get(item.item_key);
    if (!progress) throw new Error("Could not load the saved item progress.");
    return { intent, item, available: progress.available_to_release };
  });
  const partials = prepared.filter(({ intent }) => intent.action === "partial");
  const partialQuantities = partials.length
    ? await promptPartialReleases(partials.map(({ item, available }) => ({
      itemName: item.item_name || "Item",
      available
    })))
    : [];
  if (partialQuantities === null) {
    toast("Entry saved; no goods were released.");
    return;
  }
  let partialIndex = 0;
  for (const { intent, item, available } of prepared) {
    if (intent.action === "ready" && available === 0) continue;
    const qty = intent.action === "partial" ? partialQuantities[partialIndex++] : null;
    const { error } = await client.rpc("release_item", {
      p_delivery_id: deliveryId,
      p_item_key: item.item_key,
      p_qty: qty,
      p_note: null
    });
    if (error) throw error;
  }
}

async function submitDelivery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const payload = Object.fromEntries(new FormData(form));
  const productionStoreForm = isProductionStoreMode() && !deliveryEditId;
  const productionEntry = productionStoreForm && !productionEditId;
  let parsedItems;
  try {
    parsedItems = JSON.parse(payload.items || "[]");
  } catch {
    toast("Add valid item details before requesting delivery.", "error");
    return;
  }
  const brandingModeValue = String(payload.branding_modes || "").trim();
  const items = deliveryItemsMarkup(parsedItems).map((line) => ({
    ...line,
    so_number: normalizeSoNumber(line.so_number),
    branding_mode: brandingModeValue || null
  }));
  const releaseIntents = productionStoreForm
    ? items.flatMap((line, index) => ["ready", "partial"].includes(line.goods_status)
      ? [{ index, action: line.goods_status }] : [])
    : [];
  if (productionEditId) {
    items.forEach((line) => {
      line.goods_status = productionEditOriginalGoodsStatuses.get(line.item_key) || line.goods_status || "not_ready";
    });
  }
  if (productionStoreForm) {
    items.forEach((line) => {
      if (!hasSoNumber(line.so_number)) line.so_number = "";
    });
    if (!items.length || items.some((line) => !line.item_name || !/^[1-9]\d*$/.test(line.quantity)
      || productionEntry && !line.goods_status
      || line.item_name.length > 200 || line.so_number.length > 200 || line.address.length > 200
    )) {
      toast("Add an item name and a positive whole-number job card total. Optional item details must be valid when entered.", "error");
      return;
    }
  } else if (!items.length || items.some((line) => !hasSoNumber(line.so_number) || !line.item_name || !line.address
    || !/^[1-9]\d*$/.test(line.quantity) || Number(line.quantity) > 99999)) {
    toast("Add complete item lines with a positive whole-number quantity.", "error");
    return;
  }
  if (!productionStoreForm && !payload.contact_number.trim()) {
    toast("Enter a contact number.", "error");
    return;
  }
  if (!productionStoreForm && !payload.delivery_time
    || payload.delivery_time && payload.delivery_time !== "any" && (!hourlySlots().some((slot) => slot.start === payload.delivery_time)
      || payload.delivery_date === today && payload.delivery_time <= currentNairobiTime())) {
    toast("Choose an available one-hour delivery slot.", "error");
    return;
  }
  const returnToConflict = () => {
    openDeliveryItems();
    document.querySelectorAll("#delivery-item-lines .delivery-item-row")[deliveryConflictLineIndex]
      ?.querySelector('[name="so_number"]')?.focus();
  };
  if (!await checkDeliveryItemPairs(items, null, returnToConflict, true, true)) return;
  setBusy(button, true, "Requesting…");
  try {
    if (productionEditId) {
      for (const line of items) {
        const oldQuantity = productionEditOriginalQuantities.get(line.item_key);
        if (oldQuantity !== undefined && String(oldQuantity) !== line.quantity) {
          const { error } = await client.rpc("change_job_card_total", {
            p_delivery_id: productionEditId,
            p_item_key: line.item_key,
            p_new_qty: Number(line.quantity)
          });
          if (error) throw error;
        }
      }
    }
    const values = {
      client_name: payload.client_name.trim() || null,
      contact_name: payload.contact_name.trim() || null,
      contact_number: payload.contact_number.trim() || null,
      items,
      delivery_time: !payload.delivery_time || payload.delivery_time === "any" ? null : payload.delivery_time,
      delivery_time_any: payload.delivery_time === "any",
      delivery_date: payload.delivery_date || null,
      special_instruction: payload.special_instruction.trim() || null
    };
    const result = productionEditId
      ? await client.from("deliveries").update(values)
        .eq("id", productionEditId).select("id,ref_no,items").single()
      : deliveryEditId
      ? await client.from("deliveries").update({
        ...values,
        salesperson_id: profile.id,
        handoff_status: "requested"
      }).eq("id", deliveryEditId).eq("salesperson_id", profile.id)
        .in("handoff_status", ["pending_details", "requested"]).select("id,ref_no").single()
      : await client.from("deliveries").insert({
        ...values,
        created_by: profile.id,
        ...(productionEntry
          ? { salesperson_id: payload.salesperson_id, handoff_status: "pending_details" }
          : profile.role === "salesperson" ? { salesperson_id: profile.id } : {})
      }).select("id,ref_no,items").single();
    const { data, error } = result;
    if (error) throw error;
    deliveryOriginalItemPairs = null;
    const savedMessage = productionEditId
      ? `Production entry ${data.ref_no} updated.`
      : deliveryEditId
      ? `Delivery request submitted as ${data.ref_no}.`
      : productionEntry ? `Production entry saved as ${data.ref_no}.` : `Delivery request saved as ${data.ref_no}.`;
    if (productionEditId) {
      closeProductionDeliveryEdit();
    } else if (deliveryEditId) {
      closeDeliveryEdit();
    } else {
      form.reset();
      document.querySelector('[name="items"]').value = "[]";
      document.querySelector("#delivery-items-open").textContent = "Click to add item details";
      form.classList.add("hidden");
      document.querySelector("#delivery-form-toggle").textContent = "New request";
    }
    toast(savedMessage);
    if (releaseIntents.length) {
      try {
        await applyProductionReleaseIntents(data.id, data.items, releaseIntents);
      } catch (error) {
        toast(`Saved, but a release could not be recorded: ${error.message || "unknown error"}`, "error");
      }
    }
    try {
      await patchDeliveryRowsById([data.id]);
    } catch (error) {
      toast(`Saved, but the delivery list could not refresh: ${error.message || "unknown error"}`, "error");
    }
  } catch (error) {
    const duplicate = String(error.message || "").match(/^DUPLICATE_SO_ITEM:(.*):([^:]*):([^:]*)$/);
    if (duplicate) {
      const conflictIndex = items.findIndex((line) => normalizeSoNumber(line.so_number).split(", ")
        .includes(duplicate[1]) && deliveryItemKey(line.item_name) === duplicate[2]);
      deliveryConflictLineIndex = Math.max(0, conflictIndex);
      const returnToConflict = () => {
        openDeliveryItems();
        document.querySelectorAll("#delivery-item-lines .delivery-item-row")[deliveryConflictLineIndex]
          ?.querySelector('[name="so_number"]')?.focus();
      };
      await showDuplicateSaveConflict(duplicate[1], duplicate[2], duplicate[3], returnToConflict);
    } else {
      toast(error.message || "Could not save the delivery request.", "error");
    }
  } finally {
    setBusy(button, false);
  }
}

function canSalespersonEditDelivery(row) {
  return profile.role === "salesperson"
    && row.salesperson_id === profile.id
    && ["pending_details", "requested"].includes(row.handoff_status)
    && row.dispatch_status !== "Delivered"
    && !row.delivered_at;
}

function openDeliveryEdit(row) {
  if (!canSalespersonEditDelivery(row)) return;
  const form = document.querySelector("#delivery-request-form");
  const dialog = document.querySelector("#delivery-edit-dialog");
  deliveryEditId = row.id;
  deliveryOriginalItemPairs = snapshotDeliveryItemPairs(row.items || []);
  clearDeliveryItemConflictState();
  configureDeliveryForm(form);
  form.elements.client_name.value = row.client_name || "";
  form.elements.contact_name.value = row.contact_name || "";
  form.elements.contact_number.value = row.contact_number || "";
  setDeliveryBrandingSelection(form, deliveryBrandingModes(row));
  form.elements.delivery_date.value = row.delivery_date || "";
  updateDeliverySlotOptions();
  form.elements.delivery_time.value = row.delivery_time_any ? "any" : row.delivery_time || "";
  form.elements.special_instruction.value = row.special_instruction || "";
  form.elements.items.value = JSON.stringify(row.items || []);
  document.querySelector("#delivery-items-open").textContent = deliveryItemSummary(row.items);
  const clearButton = form.querySelector('[type="reset"]');
  clearButton.type = "button";
  clearButton.textContent = "Discard";
  form.querySelector('[type="submit"]').textContent = "Submit";
  form.classList.remove("hidden");
  document.querySelector("#delivery-edit-form-slot").append(form);
  dialog.showModal();
  form.elements.client_name.focus();
}

function openProductionDeliveryEdit(row) {
  if (!isProductionStoreMode() || !canManageProductionReleases()
    || profile.role !== "admin" && row.created_by !== profile.id && row.created_by !== row.salesperson_id) return;
  const form = document.querySelector("#delivery-request-form");
  if (!form.classList.contains("hidden") && !confirm("Discard the current unsaved delivery entry?")) return;
  productionEditId = row.id;
  productionEditOriginalQuantities = new Map((row.items || []).map((line) => [line.item_key, String(line.quantity)]));
  productionEditOriginalGoodsStatuses = new Map((row.items || []).map((line) => [line.item_key, line.goods_status]));
  productionEditCanChangeTotal = profile.role === "admin"
    || hasProductionStoreAccess(profile) && row.created_by !== row.salesperson_id;
  document.querySelector("#delivery-item-add").disabled = !productionEditCanChangeTotal;
  deliveryOriginalItemPairs = snapshotDeliveryItemPairs(row.items || []);
  clearDeliveryItemConflictState();
  form.elements.salesperson_id.value = row.salesperson_id;
  form.elements.salesperson_id.disabled = true;
  setDeliveryBrandingSelection(form, deliveryBrandingModes(row));
  form.elements.client_name.value = row.client_name || "";
  form.elements.contact_name.value = row.contact_name || "";
  form.elements.contact_number.value = row.contact_number || "";
  form.elements.delivery_date.value = row.delivery_date || "";
  updateDeliverySlotOptions();
  form.elements.delivery_time.value = row.delivery_time_any ? "any" : row.delivery_time || "";
  form.elements.special_instruction.value = row.special_instruction || "";
  form.elements.items.value = JSON.stringify((row.items || []).map((line) => ({ ...line, goods_status: "" })));
  document.querySelector("#delivery-items-open").textContent = productionStoreItemSummary(row.items, row.id);
  form.querySelector('[type="submit"]').textContent = "Save changes";
  form.querySelector('[type="reset"]').textContent = "Discard";
  form.classList.remove("hidden");
  document.querySelector("#delivery-edit-title").textContent = "Edit production entry";
  document.querySelector("#delivery-edit-form-slot").append(form);
  document.querySelector("#delivery-edit-dialog").showModal();
  form.elements.client_name.focus();
}

function closeProductionDeliveryEdit() {
  if (!productionEditId) return;
  const deliveryId = productionEditId;
  productionEditId = null;
  productionEditOriginalQuantities = new Map();
  productionEditOriginalGoodsStatuses = new Map();
  productionEditCanChangeTotal = false;
  document.querySelector("#delivery-item-add").disabled = false;
  deliveryOriginalItemPairs = null;
  const form = document.querySelector("#delivery-request-form");
  form.reset();
  form.elements.items.value = "[]";
  form.elements.salesperson_id.disabled = false;
  document.querySelector("#delivery-items-open").textContent = "Click to add item details";
  form.querySelector('[type="submit"]').textContent = "Request";
  form.querySelector('[type="reset"]').textContent = "Clear";
  form.classList.add("hidden");
  const panel = document.querySelector("#delivery-request-panel");
  panel.querySelector(".section-heading").after(form);
  const dialog = document.querySelector("#delivery-edit-dialog");
  if (dialog.open) dialog.close();
  document.querySelector("#delivery-form-toggle").textContent = "New request";
  document.querySelector(`#delivery-rows [data-entry-id="${CSS.escape(deliveryId)}"]`)?.focus();
}

function closeDeliveryEdit() {
  if (!deliveryEditId) return;
  deliveryEditId = null;
  deliveryOriginalItemPairs = null;
  const form = document.querySelector("#delivery-request-form");
  const dialog = document.querySelector("#delivery-edit-dialog");
  const clearButton = form.querySelector(".form-actions [type='reset'], .form-actions [type='button']");
  form.reset();
  form.elements.items.value = "[]";
  document.querySelector("#delivery-items-open").textContent = "Click to add item details";
  form.querySelector('[type="submit"]').textContent = "Request";
  clearButton.type = "reset";
  clearButton.textContent = "Clear";
  form.classList.add("hidden");
  const panel = document.querySelector("#delivery-request-panel");
  panel.insertBefore(form, document.querySelector("#delivery-form-anchor").nextSibling);
  configureDeliveryForm(form, isProductionStoreMode());
  if (dialog.open) dialog.close();
}

async function loadDeliverySalespeople() {
  const data = await loadActiveDeliverySalespeople();
  const select = document.querySelector("#delivery-request-form").elements.salesperson_id;
  select.innerHTML = '<option value="">Choose salesperson</option>' + data.map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`
  ).join("");
}

async function loadActiveDeliverySalespeople() {
  if (activeDeliverySalespeople
    && Date.now() - activeDeliverySalespeopleFetchedAt < DELIVERY_REFERENCE_CACHE_TTL_MS) {
    return activeDeliverySalespeople;
  }
  const { data, error } = await client.from("profiles").select("id,full_name")
    .eq("role", "salesperson").eq("active", true).order("full_name");
  if (error) throw error;
  activeDeliverySalespeople = data || [];
  activeDeliverySalespeopleFetchedAt = Date.now();
  activeDeliverySalespeople.forEach((user) => {
    deliveryProfileCache.set(user.id, {
      profile: { ...user, salesperson: true },
      fetchedAt: activeDeliverySalespeopleFetchedAt
    });
  });
  return activeDeliverySalespeople;
}

async function loadDeliveryProfiles(ids, salespersonOnly = false) {
  const uniqueIds = [...new Set(ids)];
  const now = Date.now();
  const idsToFetch = uniqueIds.filter((id) => {
    const cached = deliveryProfileCache.get(id);
    return !cached || now - cached.fetchedAt >= DELIVERY_REFERENCE_CACHE_TTL_MS
      || salespersonOnly && cached.profile.salesperson === null;
  });
  if (idsToFetch.length) {
    let query = client.from("profiles").select("id,full_name");
    if (salespersonOnly) query = query.eq("role", "salesperson");
    const { data, error } = await query.in("id", idsToFetch);
    if (error) throw error;
    const fetchedProfiles = new Map((data || []).map((user) => [user.id, user]));
    const fetchedAt = Date.now();
    idsToFetch.forEach((id) => {
      const fetched = fetchedProfiles.get(id);
      const previous = deliveryProfileCache.get(id)?.profile;
      deliveryProfileCache.set(id, {
        profile: fetched
          ? { ...fetched, salesperson: salespersonOnly ? true : previous?.salesperson ?? null }
          : { id, full_name: salespersonOnly ? previous?.full_name || null : null, salesperson: salespersonOnly ? false : previous?.salesperson ?? null },
        fetchedAt
      });
    });
  }
  return uniqueIds.map((id) => deliveryProfileCache.get(id)?.profile || null);
}

function saveDeliveryFilters() {
  try {
    sessionStorage.setItem(DELIVERY_FILTERS_KEY, JSON.stringify({
      from: document.querySelector("#delivery-date-from").value,
      to: document.querySelector("#delivery-date-to").value,
      salesperson: document.querySelector("#delivery-salesperson").value,
      production: document.querySelector("#delivery-production-filter").value,
      dispatch: document.querySelector("#delivery-dispatch-filter").value
    }));
  } catch (error) {
    console.error("Could not save delivery filters for this session.", error);
    toast("Could not save delivery filters for this session.", "error");
  }
}

function restoreDeliveryFilters() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(DELIVERY_FILTERS_KEY) || "null");
  } catch (error) {
    console.error("Could not read delivery filters for this session.", error);
    return;
  }
  if (!saved || typeof saved !== "object") return;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (datePattern.test(saved.from || "")) document.querySelector("#delivery-date-from").value = saved.from;
  if (datePattern.test(saved.to || "")) document.querySelector("#delivery-date-to").value = saved.to;
  if (["", "Not ready", "Ready"].includes(saved.production)) {
    document.querySelector("#delivery-production-filter").value = saved.production;
  }
  if (["", "not-packed", "packed", "Not delivered", "Delivered"].includes(saved.dispatch)) {
    document.querySelector("#delivery-dispatch-filter").value = saved.dispatch;
  }
  if (typeof saved.salesperson === "string") {
    document.querySelector("#delivery-salesperson").dataset.savedValue = saved.salesperson;
  }
}

async function loadDeliveryFilterSalespeople() {
  const select = document.querySelector("#delivery-salesperson");
  deliverySalespersonNames = new Map();
  if (profile.role === "salesperson") {
    deliverySalespersonNames.set(profile.id, profile.full_name);
    document.querySelector("#delivery-salesperson-filter").classList.add("hidden");
    return;
  }
  const salespersonIds = new Set(deliveryRows.map((row) => row.salesperson_id || row.created_by).filter(Boolean));
  if (!salespersonIds.size) {
    select.innerHTML = '<option value="">All salespeople</option>';
    return;
  }
  const users = (await loadDeliveryProfiles([...salespersonIds], true))
    .filter((user) => user?.salesperson)
    .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
  deliverySalespersonNames = new Map(users.map((user) => [user.id, user.full_name]));
  const selected = select.value;
  select.innerHTML = '<option value="">All salespeople</option>' + users.map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`
  ).join("");
  const savedValue = select.dataset.savedValue;
  const value = users.some((user) => user.id === selected) ? selected : savedValue;
  if (value && users.some((user) => user.id === value)) select.value = value;
}

async function loadProductionStoreSalespeople() {
  const ids = [...new Set(deliveryRows.map((row) => row.salesperson_id || row.created_by).filter(Boolean))];
  deliverySalespersonNames = new Map();
  if (ids.length) {
    const users = (await loadDeliveryProfiles(ids)).filter((user) => user?.full_name);
    deliverySalespersonNames = new Map(users.map((user) => [user.id, user.full_name]));
  }
  const select = document.querySelector("#production-salesperson-filter");
  if (!select) return;
  const selected = select.value;
  const names = [...new Set(deliveryRows.map(deliverySalespersonName).filter((name) => name !== "—"))]
    .sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All salespeople</option>' + names.map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
  ).join("");
  if (names.includes(selected)) select.value = selected;
}

async function initializeDeliveryFilters() {
  restoreDeliveryFilters();
  await loadDeliveryFilterSalespeople();
  const roleChipMode = isDeliveryRoleChipMode();
  document.querySelector("#delivery-role-status-chips").classList.toggle("hidden", !roleChipMode && !showsDeliveryUrgentPill());
  if (roleChipMode) {
    document.querySelector("#delivery-production-filter").closest("label").classList.add("hidden");
    document.querySelector("#delivery-dispatch-filter").closest("label").classList.add("hidden");
    document.querySelector("#delivery-production-filter").value = "";
    document.querySelector("#delivery-dispatch-filter").value = "";
    deliveryRoleStatusFilter = "pending";
  }
  const filterSelectors = [
    "#delivery-date-from",
    "#delivery-date-to",
    "#delivery-salesperson",
    ...roleChipMode ? [] : ["#delivery-production-filter", "#delivery-dispatch-filter"]
  ];
  filterSelectors.forEach((selector) => {
    document.querySelector(selector).addEventListener("change", () => {
      saveDeliveryFilters();
      renderDeliveryRows();
    });
  });
  document.querySelector("#delivery-clear-filters").addEventListener("click", () => {
    document.querySelector("#delivery-date-from").value = "";
    document.querySelector("#delivery-date-to").value = "";
    document.querySelector("#delivery-salesperson").value = "";
    document.querySelector("#delivery-production-filter").value = "";
    document.querySelector("#delivery-dispatch-filter").value = "";
    deliveryBrandingFilter = "all";
    deliveryUrgentFilter = false;
    if (roleChipMode) {
      deliveryRoleStatusFilter = "pending";
      document.querySelector("#delivery-search").value = "";
    }
    saveDeliveryFilters();
    renderDeliveryRows();
  });
  document.querySelector("#delivery-reset-filters").addEventListener("click", () => {
    document.querySelector("#delivery-date-from").value = "";
    document.querySelector("#delivery-date-to").value = "";
    document.querySelector("#delivery-salesperson").value = "";
    deliveryBrandingFilter = "all";
    deliveryUrgentFilter = false;
    if (roleChipMode) {
      deliveryRoleStatusFilter = "pending";
      document.querySelector("#delivery-search").value = "";
    } else {
      document.querySelector("#delivery-production-filter").value = "Not ready";
      document.querySelector("#delivery-dispatch-filter").value = "Not delivered";
    }
    saveDeliveryFilters();
    renderDeliveryRows();
  });
  saveDeliveryFilters();
}

async function fetchAllDeliveryRows() {
  const rows = [];
  const select = profile.role === "salesperson" && !hasProductionAccess(profile) && !hasDispatchAccess(profile)
    ? `${deliverySelect},goods_status_updated_at` : deliverySelect;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from(deliveryReadTable()).select(select)
      .order("sr", { ascending: false }).range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) return rows;
  }
}

async function loadDeliveries() {
  const token = ++deliveryQueryToken;
  try {
    const rows = await fetchAllDeliveryRows();
    if (token !== deliveryQueryToken) return;
    deliveryLastFullRefreshAt = Date.now();
    deliveryRows = rows;
    await loadProductionStoreProgress(rows.map((row) => row.id), true);
    await loadDispatchProgress(rows.map((row) => row.id), true);
    if (page === "production-store.html") await loadProductionStoreSalespeople();
    if (page === "deliveries.html") await initializeDeliveryFilters();
    if (token !== deliveryQueryToken) return;
    renderDeliveryRows();
  } catch (error) {
    toast(error.message || "Could not load deliveries.", "error");
  }
}

function replaceDeliveryRows(updatedRows, ids, render = true) {
  const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
  const existingById = new Map(deliveryRows.map((row) => [row.id, row]));
  for (const id of ids) {
    const updated = updatedById.get(id);
    if (updated) existingById.set(id, { ...existingById.get(id), ...updated });
    else existingById.delete(id);
  }
  deliveryRows = [...existingById.values()];
  if (render) renderDeliveryRows(ids);
}

function deliveryStatusSignature(row) {
  return JSON.stringify([
    row.production_status, row.goods_status, row.dispatch_status,
    row.ready_at, row.dispatched_at, row.delivered_at
  ]);
}

async function patchDeliveryRowsById(ids) {
  if (document.hidden || !ids.length) return;
  deliveryRowsVersion += 1;
  const uniqueIds = [...new Set(ids)];
  const previousRows = new Map(deliveryRows.map((row) => [row.id, row]));
  const select = profile.role === "salesperson" ? `${deliverySelect},goods_status_updated_at` : deliverySelect;
  const rows = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const { data, error } = await client.from(deliveryReadTable()).select(select)
      .in("id", uniqueIds.slice(index, index + 100));
    if (error) throw error;
    rows.push(...(data || []));
  }
  const statusChangedIds = new Set(rows.filter((row) => {
    const previous = previousRows.get(row.id);
    return previous && deliveryStatusSignature(previous) !== deliveryStatusSignature(row);
  }).map((row) => row.id));
  replaceDeliveryRows(rows, uniqueIds, false);
  await loadProductionStoreProgress(uniqueIds);
  await loadDispatchProgress(uniqueIds);
  if (page === "deliveries.html") {
    try {
      await loadDeliveryFilterSalespeople();
    } catch (error) {
      toast(error.message || "Could not refresh the salesperson filter.", "error");
    }
  }
  if (page === "production-store.html") {
    try {
      await loadProductionStoreSalespeople();
    } catch (error) {
      toast(error.message || "Could not refresh production store salespeople.", "error");
    }
  }
  renderDeliveryRows(uniqueIds, statusChangedIds);
  if (page === "deliveries.html" && statusChangedIds.size) {
    document.querySelector("#delivery-period").dispatchEvent(new Event("change"));
  }
  await refreshAssignedPendingDeliveries();
  await refreshUrgentDeliveryAlerts();
}

async function refreshDeliveryRows() {
  if (document.hidden) return;
  const token = ++deliveryRefreshToken;
  const version = deliveryRowsVersion;
  const freshRows = await fetchAllDeliveryRows();
  if (document.hidden || token !== deliveryRefreshToken || version !== deliveryRowsVersion) return;
  const progressChangedIds = await loadProductionStoreProgress(freshRows.map((row) => row.id), true);
  const dispatchChangedIds = await loadDispatchProgress(freshRows.map((row) => row.id), true);
  if (document.hidden || token !== deliveryRefreshToken || version !== deliveryRowsVersion) return;
  deliveryLastFullRefreshAt = Date.now();
  const oldById = new Map(deliveryRows.map((row) => [row.id, row]));
  const freshById = new Map(freshRows.map((row) => [row.id, row]));
  const changedIds = new Set();
  const statusChangedIds = new Set();
  for (const row of freshRows) {
    const old = oldById.get(row.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(row)) changedIds.add(row.id);
    if (old && deliveryStatusSignature(old) !== deliveryStatusSignature(row)) statusChangedIds.add(row.id);
  }
  for (const id of oldById.keys()) {
    if (!freshById.has(id)) changedIds.add(id);
  }
  progressChangedIds.forEach((id) => changedIds.add(id));
  dispatchChangedIds.forEach((id) => changedIds.add(id));
  if (!changedIds.size) return;
  replaceDeliveryRows(freshRows, [...changedIds], false);
  if (page === "deliveries.html") {
    try {
      await loadDeliveryFilterSalespeople();
    } catch (error) {
      toast(error.message || "Could not refresh the salesperson filter.", "error");
    }
  }
  if (page === "production-store.html") {
    try {
      await loadProductionStoreSalespeople();
    } catch (error) {
      toast(error.message || "Could not refresh production store salespeople.", "error");
    }
  }
  renderDeliveryRows([...changedIds], statusChangedIds);
  if (page === "deliveries.html" && statusChangedIds.size) {
    document.querySelector("#delivery-period").dispatchEvent(new Event("change"));
  }
  await refreshAssignedPendingDeliveries();
  await refreshUrgentDeliveryAlerts();
}

async function loadActiveVehicles(force = false) {
  if (!force && Date.now() - activeDeliveryVehiclesFetchedAt < DELIVERY_REFERENCE_CACHE_TTL_MS) {
    return vehicleRows;
  }
  const { data, error } = await client.from("vehicles").select("id,registration_number,description")
    .eq("active", true).order("registration_number").limit(100);
  if (error) throw error;
  vehicleRows = data || [];
  activeDeliveryVehiclesFetchedAt = Date.now();
  deliveryVehicleNameCache.clear();
  vehicleRows.forEach((vehicle) => {
    deliveryVehicleNameCache.set(vehicle.id, {
      registration_number: vehicle.registration_number,
      fetchedAt: activeDeliveryVehiclesFetchedAt
    });
  });
  return vehicleRows;
}

async function loadDeliveryVehicleName(id) {
  const cached = deliveryVehicleNameCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < DELIVERY_REFERENCE_CACHE_TTL_MS) {
    return cached.registration_number || "—";
  }
  const { data, error } = await client.from("vehicles").select("registration_number").eq("id", id).maybeSingle();
  if (error) throw error;
  const registrationNumber = data?.registration_number || null;
  deliveryVehicleNameCache.set(id, { registration_number: registrationNumber, fetchedAt: Date.now() });
  return registrationNumber || "—";
}

function deliveryActions(row) {
  if (isProductionStoreMode()) return "";
  const role = profile.role;
  const productionAccess = role === "admin" || hasProductionAccess(profile);
  const dispatchAccess = role === "admin" || hasDispatchAccess(profile);
  const isAssignedSalesperson = role !== "admin" && row.salesperson_id === profile.id;
  const dispatchProgress = dispatchRequestProgress(row.id);
  if (isDispatchScreen() ? dispatchProgress?.dispatch_state === "Delivered" : row.dispatch_status === "Delivered") return "";
  const actions = [];
  if (productionAccess && row.production_status !== "Ready" && !isAssignedSalesperson) {
    const goodsReady = ["ready", "partial"].includes(deliveryGoodsStatus(row));
    actions.push(`<button class="primary" data-delivery-ready="${escapeHtml(row.id)}"${goodsReady ? "" : " disabled"}>Ready</button>`);
  }
  if (dispatchAccess) actions.push(`<button type="button" class="primary" data-dispatch-open="${escapeHtml(row.id)}">Dispatch</button>`);
  return actions.join("");
}

function renderProductionGoodsChips(rows) {
  const root = document.querySelector("#production-goods-chips");
  if (!root) return;
  const counts = {
    pending: rows.filter((row) => !currentDeliveryGoodsStatus(row) || ["partial", "not_ready"].includes(currentDeliveryGoodsStatus(row))).length,
    ready: rows.filter((row) => currentDeliveryGoodsStatus(row) === "ready").length,
    partial: rows.filter((row) => currentDeliveryGoodsStatus(row) === "partial").length,
    not_ready: rows.filter((row) => currentDeliveryGoodsStatus(row) === "not_ready").length,
    all: rows.length
  };
  const chips = [
    ["pending", "Pending", "pending"],
    ["ready", "Ready", "ready"],
    ["partial", "Partially ready", "partial"],
    ["not_ready", "Not ready", "not-ready"],
    ["all", "All", "all"]
  ];
  renderStatusChipButtons(root, chips.map(([value, label, style]) => ({ value, label, style })), new Map(Object.entries(counts)),
    productionGoodsFilter, (value) => {
      productionGoodsFilter = value;
      renderDeliveryRows();
    }, "goodsFilter");
}


function isDeliveryRoleChipMode() {
  return page === "deliveries.html" && (hasProductionAccess(profile) || hasDispatchAccess(profile));
}

function showsDeliveryUrgentPill() {
  return page === "deliveries.html"
    && (profile.role === "salesperson" || profile.role === "admin");
}

function deliveryOperationalRole() {
  if (hasDispatchAccess(profile)) return "dispatch";
  if (hasProductionAccess(profile)) return "production";
  return profile.role;
}

function deliveryRoleStatusMatches(row, value) {
  if (value === "all") return true;
  if (value === "urgent") return deliveryAddressUrgent(row);
  if (!hasDispatchAccess(profile)) {
    if (value === "pending") return row.production_status === "Not ready";
    return row.production_status === value;
  }
  if (value === "pending") return row.dispatch_status === "Not delivered";
  return row.dispatch_status === value;
}

function deliveryRoleStatusLabels() {
  const role = deliveryOperationalRole();
  return [...(DELIVERY_ROLE_STATUS_LABELS[role]
    || DELIVERY_ROLE_STATUS_LABELS.dispatch.filter(({ value }) => value === "urgent"))];
}

function deliveryRoleStatusPills(rows) {
  const labels = deliveryRoleStatusLabels();
  const chips = labels.map((chip) =>
    chip.value === "urgent" && !rows.some(deliveryAddressUrgent)
      ? { ...chip, style: "grey" }
      : chip);
  const counts = new Map(chips.map(({ value }) => [
    value,
    value === "all" ? rows.length : rows.filter((row) => deliveryRoleStatusMatches(row, value)).length
  ]));
  renderStatusChipButtons(document.querySelector("#delivery-role-status-chips"), chips, counts,
    isDeliveryRoleChipMode() ? deliveryRoleStatusFilter : deliveryUrgentFilter ? "urgent" : "",
    (value) => {
      if (isDeliveryRoleChipMode()) {
        deliveryRoleStatusFilter = value;
      } else {
        deliveryUrgentFilter = value === "urgent" ? !deliveryUrgentFilter : false;
      }
      renderDeliveryRows();
    });
}

function deliveryBrandingPills(rows) {
  const modes = ["all", ...brandingModes];
  const counts = new Map(modes.map((mode) => [
    mode,
    mode === "all" ? rows.length : rows.filter((row) => deliveryBrandingModes(row).includes(mode)).length
  ]));
  renderStatusChipButtons(
    document.querySelector("#delivery-branding-filter-chips"),
    modes.map((mode) => ({
      value: mode,
      label: mode === "all" ? "All" : mode,
      style: mode === "all" ? "all" : "ready"
    })),
    counts,
    deliveryBrandingFilter,
    (value) => {
      deliveryBrandingFilter = value;
      renderDeliveryRows();
    },
    "brandingFilter"
  );
}

function configureDeliveryTableHeaders() {
  const header = document.querySelector("#delivery-table-head");
  if (deliveryOperationalRole() === "production") {
    header.innerHTML = '<th data-sort="delivery_schedule">Delivery date</th><th>Client name</th><th>Delivery address</th><th>SO number</th><th>Items</th><th>Branding</th><th>Salesperson</th><th>Goods status</th><th>Production</th><th>Dispatch</th><th>Actions</th>';
  } else if (profile.role === "salesperson" && !isDeliveryRoleChipMode()) {
    header.innerHTML = '<th data-sort="sr">SR</th><th data-sort="delivery_schedule">Delivery date</th><th>Client/contact</th><th>Delivery address</th><th>SO number</th><th>Items</th><th>Salesperson</th><th>Branding</th><th>Goods status</th><th>Production</th><th>Dispatch</th><th>Actions</th>';
  }
}

function productionStoreItemsCell(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const lines = items.map((item) => {
    const progress = productionItemProgress(row.id, item.item_key);
    const released = progress ? `${progress.released}/${progress.job_card_total}` : "—/—";
    return `<span>${escapeHtml(item.item_name || "Item")} <small class="muted">Released ${escapeHtml(released)} · Latest release ${escapeHtml(productionLatestReleaseLabel(row.id, item.item_key))}</small></span>`;
  }).join("<br>");
  return `<td class="delivery-items-cell" data-delivery-items="${escapeHtml(row.id)}" role="button" tabindex="0" aria-label="View item release details"><small class="muted">${lines}</small></td>`;
}

function deliveryMatchesBaseFilters(row) {
  const query = document.querySelector("#delivery-search")?.value.trim().toLowerCase() || "";
  if (page === "production-store.html") {
    const salesperson = deliverySalespersonName(row);
    const selectedSalesperson = document.querySelector("#production-salesperson-filter")?.value || "";
    return (!selectedSalesperson || salesperson === selectedSalesperson)
      && (!query || [salesperson, ...deliverySoNumbers(row), row.client_name, row.sr]
        .some((value) => String(value || "").toLowerCase().includes(query)));
  }
  if (page !== "deliveries.html") {
    return !query || [row.ref_no, row.client_name, row.contact_name]
      .some((value) => String(value || "").toLowerCase().includes(query));
  }
  const dateFrom = document.querySelector("#delivery-date-from").value;
  const dateTo = document.querySelector("#delivery-date-to").value;
  const salespersonId = document.querySelector("#delivery-salesperson").value;
  if (dateFrom && (!row.delivery_date || row.delivery_date < dateFrom)) return false;
  if (dateTo && (!row.delivery_date || row.delivery_date > dateTo)) return false;
  if (salespersonId && (row.salesperson_id || row.created_by) !== salespersonId) return false;
  const searchValues = [row.client_name, ...deliverySoNumbers(row)];
  if (/^\d+$/.test(query)) searchValues.push(row.sr);
  if (query && !searchValues.some((value) => String(value || "").toLowerCase().includes(query))) return false;
  if (!isDeliveryRoleChipMode()) {
    const production = document.querySelector("#delivery-production-filter").value;
    const dispatch = document.querySelector("#delivery-dispatch-filter").value;
    if (production && row.production_status !== production) return false;
    if (dispatch === "not-packed" && !(row.dispatch_status === "Not delivered" && !row.dispatched_at)) return false;
    if (dispatch === "packed" && !(row.dispatch_status === "Not delivered" && Boolean(row.dispatched_at))) return false;
    if (dispatch && !["not-packed", "packed"].includes(dispatch) && row.dispatch_status !== dispatch) return false;
  }
  return true;
}

function deliveryRowMarkup(row) {
  const dispatchView = isDispatchScreen();
  const requestProgress = dispatchView ? dispatchRequestProgress(row.id) : null;
  const contactName = row.contact_name?.trim() || "";
  const contactNumber = row.contact_number?.trim() || "";
  const salespersonContact = `${escapeHtml(contactName || "—")}${contactName && contactNumber ? " · " : " "}${escapeHtml(contactNumber || "—")}`;
  const contactDetails = [contactName, contactNumber].filter(Boolean).map(escapeHtml).join(" · ") || "—";
  const clientContact = `${escapeHtml(row.client_name || "—")}${hasProductionAccess(profile) || hasDispatchAccess(profile) ? "" : `<br><span class="muted">${profile.role === "salesperson"
    ? salespersonContact
    : contactDetails}</span>`}`;
  const itemsCell = `<td class="delivery-items-cell" data-delivery-items="${escapeHtml(row.id)}" role="button" tabindex="0" aria-label="View all items and SO numbers">${dispatchView ? dispatchItemsSummary(row) : deliveryItemSummary(row.items)}</td>`;
  const brandingCell = `<td>${escapeHtml(deliveryBrandingModes(row).join(", ") || "—")}</td>`;
  const addressCell = `<td><span class="delivery-address-cell" title="${escapeHtml(deliveryAddress(row))}">${escapeHtml(deliveryAddress(row) || "—")}</span></td>`;
  const soNumberCell = `<td>${deliverySoNumberCell(row)}</td>`;
  const deliveryDateCell = `<td>${escapeHtml(row.delivery_date || "—")}${row.delivery_date ? `<br>${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}` : ""}</td>`;
  const groupedDeliveryDate = `<small class="delivery-secondary"><span class="delivery-date-value">${escapeHtml(row.delivery_date || "—")}</span>${row.delivery_date ? `<br><span class="delivery-time-value">${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}</span>` : ""}</small>`;
  const groupedClientContact = `${clientContact}<br><small class="delivery-secondary">${escapeHtml(deliveryAddress(row) || "—")}</small><br><small class="delivery-secondary">${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</small>`;
  const deliveryColumns = page === "production-store.html"
    ? `<td>${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</td><td>${escapeHtml(row.client_name || "—")}</td>${productionStoreItemsCell(row)}<td>${escapeHtml(row.delivery_date || "—")}</td><td>${currentDeliveryGoodsStatus(row)
      ? `<span class="delivery-status-${currentDeliveryGoodsStatus(row) === "ready" ? "green" : currentDeliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${currentDeliveryGoodsStatus(row) === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(currentDeliveryGoodsStatus(row))}</span>`
      : "—"}</td>`
    : dispatchView
    ? `<td>${groupedClientContact}</td>${addressCell}${soNumberCell}${itemsCell}<td>${escapeHtml(deliverySalespersonName(row))}</td><td>${escapeHtml(requestProgress?.goods_status || "—")}</td>`
    : page === "deliveries.html" && deliveryOperationalRole() === "production"
    ? `${deliveryDateCell}<td>${groupedClientContact}</td>${addressCell}${soNumberCell}${itemsCell}${brandingCell}<td>${escapeHtml(deliverySalespersonName(row))}</td><td>${deliveryGoodsStatus(row)
      ? `<span class="delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>`
      : "—"}</td>`
    : page === "deliveries.html" && profile.role === "salesperson" && !isDeliveryRoleChipMode()
    ? `<td>${escapeHtml(row.sr)}${groupedDeliveryDate}</td>${deliveryDateCell}<td>${groupedClientContact}</td>${addressCell}${soNumberCell}${itemsCell}<td>${escapeHtml(deliverySalespersonName(row))}</td>${brandingCell}<td>${deliveryGoodsStatus(row)
      ? `<span class="goods-status-pill delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatus(row) === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>${row.goods_status_updated_at ? `<br><small>${escapeHtml(localDateTime(row.goods_status_updated_at))}</small>` : ""}`
      : "—"}</td>`
    : page === "deliveries.html"
    ? `<td>${groupedClientContact}</td>${addressCell}${soNumberCell}${itemsCell}<td>${escapeHtml(deliverySalespersonName(row))}</td><td>${deliveryGoodsStatus(row)
      ? `<span class="delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>`
      : "—"}</td>`
    : `<td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(localDateTime(row.created_at))}</td><td>${clientContact}</td>${itemsCell}`;
  const productionCell = `<td>${dispatchView ? escapeHtml(requestProgress?.production_state || "—") : deliveryProductionStatusMarkup(row)}</td>`;
  const urgent = deliveryAddressUrgent(row);
  const missingAddressMarker = profile.role === "salesperson" && urgent
      ? '<br><small class="delivery-address-urgent">URGENT: address missing</small>'
      : "";
  const dispatchCell = `<td>${dispatchView ? escapeHtml(requestProgress?.dispatch_state || "—") : deliveryDispatchStatusMarkup(row)}${missingAddressMarker}</td>`;
  const rowLabel = deliverySoNumbers(row).join(", ") || row.ref_no || row.sr;
  const canView = ["admin", "production", "dispatch", "salesperson"].includes(profile.role)
    || hasProductionAccess(profile) || hasDispatchAccess(profile) || isProductionStoreMode();
  const viewButton = canView ? `<button type="button" class="secondary" data-delivery-view="${escapeHtml(row.id)}">View</button>` : "";
  const canEditProductionEntry = isProductionStoreMode() && canManageProductionReleases()
    && (profile.role === "admin" || row.created_by === profile.id || row.created_by === row.salesperson_id);
  const productionRowEditAttributes = canEditProductionEntry
    ? ` data-production-entry-edit tabindex="0" aria-haspopup="dialog" aria-keyshortcuts="Enter Space" aria-label="${escapeHtml(`Edit production entry ${rowLabel}`)}"`
    : "";
  const actionsCell = `<td><div class="delivery-table-actions">${viewButton}${!isProductionStoreMode() && canSalespersonEditDelivery(row) ? `<button type="button" class="primary" data-delivery-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${canEditProductionEntry ? `<button type="button" class="primary" data-production-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${isProductionStoreMode() && canManageProductionReleases() ? `<button type="button" class="secondary" data-release-history="${escapeHtml(row.id)}">Release history</button>` : ""}${!isProductionStoreMode() && profile.role === "admin" ? `<button type="button" class="danger" data-delivery-delete="${escapeHtml(row.id)}">Delete</button>` : ""}${deliveryActions(row)}</div></td>`;
  const rowDataCells = page === "production-store.html" || page === "deliveries.html"
    && (deliveryOperationalRole() === "production" || profile.role === "salesperson" && !isDeliveryRoleChipMode())
    ? deliveryColumns
    : `<td>${escapeHtml(row.sr)}</td>${deliveryDateCell}${deliveryColumns}`;
  const rowViewAttributes = page === "deliveries.html" && canView
    ? ` data-row-view tabindex="0" role="button" aria-label="${escapeHtml(`View delivery ${rowLabel}`)}"` : "";
  const rowClasses = [
    profile.role === "salesperson" && urgent ? "delivery-address-urgent-row" : "",
    canEditProductionEntry ? "production-store-edit-row" : ""
  ].filter(Boolean).join(" ");
  return `<tr data-entry-id="${escapeHtml(row.id)}"${rowViewAttributes}${productionRowEditAttributes}${rowClasses ? ` class="${rowClasses}"` : ""}>${rowDataCells}${productionCell}${dispatchCell}${actionsCell}</tr>`;
}

function waitForTransition(element, property, fallbackMs) {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(finish, fallbackMs);
    function finish() {
      window.clearTimeout(timeout);
      element.removeEventListener("transitionend", onEnd);
      resolve();
    }
    function onEnd(event) {
      if (event.target === element && event.propertyName === property) finish();
    }
    element.addEventListener("transitionend", onEnd);
  });
}

async function animateDeliveryRowExit(row) {
  const id = row.dataset.entryId;
  const tableWrap = row.closest(".table-wrap");
  if (!id || deliveryExitingRows.has(id)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    row.remove();
    return;
  }
  deliveryExitingRows.set(id, row);
  tableWrap?.classList.add("delivery-row-exit-active");
  const firstCell = row.cells[0];
  if (!firstCell) {
    row.remove();
    deliveryExitingRows.delete(id);
    return;
  }
  row.classList.add("row-exit-right");
  await waitForTransition(firstCell, "transform", 500);
  if (!row.isConnected) {
    deliveryExitingRows.delete(id);
    return;
  }
  row.style.height = `${row.getBoundingClientRect().height}px`;
  void row.offsetHeight;
  row.classList.add("row-collapse");
  row.style.height = "0px";
  await waitForTransition(row, "height", 250);
  row.remove();
  deliveryExitingRows.delete(id);
  if (!deliveryExitingRows.size) tableWrap?.classList.remove("delivery-row-exit-active");
  renderDeliveryRows();
}

async function animateProductionStoreReadyExit(row) {
  const id = row.dataset.entryId;
  if (!id || deliveryExitingRows.has(id)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    row.remove();
    return;
  }
  deliveryExitingRows.set(id, row);
  row.classList.add("production-store-ready-exit");
  await waitForTransition(row, "transform", 350);
  if (!row.isConnected) {
    deliveryExitingRows.delete(id);
    return;
  }
  row.remove();
  deliveryExitingRows.delete(id);
  renderDeliveryRows();
}

export function renderDeliveryRows(changedIds = null, statusChangedIds = new Set()) {
  const tbody = document.querySelector("#delivery-rows");
  const matchingRows = deliveryRows.filter(deliveryMatchesBaseFilters);
  if (page === "production-store.html") renderProductionGoodsChips(matchingRows);
  const visibleRows = isDeliveryRoleChipMode()
    ? matchingRows.filter((row) => deliveryRoleStatusMatches(row, deliveryRoleStatusFilter))
    : page === "production-store.html"
    ? matchingRows.filter((row) => {
      const status = currentDeliveryGoodsStatus(row);
      if (productionGoodsFilter === "pending") return !status || status === "partial" || status === "not_ready";
      if (productionGoodsFilter === "all") return true;
      return status === productionGoodsFilter;
    })
    : showsDeliveryUrgentPill() && deliveryUrgentFilter
    ? matchingRows.filter(deliveryAddressUrgent)
    : matchingRows;
  const brandingFilterRow = document.querySelector("#delivery-branding-filter-row");
  const showBrandingFilter = page === "deliveries.html" && hasProductionAccess(profile);
  if (showsDeliveryUrgentPill() || isDeliveryRoleChipMode()) {
    const statusPillRows = showBrandingFilter
      ? matchingRows.filter((row) => deliveryBrandingFilter === "all"
        || deliveryBrandingModes(row).includes(deliveryBrandingFilter))
      : matchingRows;
    deliveryRoleStatusPills(statusPillRows);
  }
  if (showBrandingFilter) {
    brandingFilterRow?.classList.remove("hidden");
    deliveryBrandingPills(visibleRows);
  } else {
    brandingFilterRow?.classList.add("hidden");
  }
  const brandingFilteredRows = showBrandingFilter
    ? visibleRows.filter((row) => deliveryBrandingFilter === "all" || deliveryBrandingModes(row).includes(deliveryBrandingFilter))
    : visibleRows;
  const filtered = sortRows(brandingFilteredRows);
  if (changedIds === null) {
    tbody.innerHTML = filtered.filter((row) => !deliveryExitingRows.has(row.id))
      .map(deliveryRowMarkup).join("");
    deliveryExitingRows.forEach((row) => tbody.append(row));
    bindDeliveryRowActions(tbody);
  } else {
    const visibleById = new Map(filtered.map((row) => [row.id, row]));
    for (const id of changedIds) {
      const current = tbody.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      const row = visibleById.get(id);
      if (!row) {
        const updated = deliveryRows.find((delivery) => delivery.id === id);
        if (current && page === "production-store.html") {
          if (productionGoodsFilter === "pending" && currentDeliveryGoodsStatus(updated) === "ready"
            && statusChangedIds.has(id)) void animateProductionStoreReadyExit(current);
          else current.remove();
        } else if (current && statusChangedIds.has(id)) void animateDeliveryRowExit(current);
        else current?.remove();
        continue;
      }
      if (deliveryExitingRows.has(id)) continue;
      const template = document.createElement("tbody");
      template.innerHTML = deliveryRowMarkup(row);
      const replacement = template.firstElementChild;
      current?.remove();
      if (current && statusChangedIds.has(id)) replacement.classList.add("row-status-flash");
      const index = filtered.findIndex((item) => item.id === id);
      const next = filtered.slice(index + 1).map((item) =>
        tbody.querySelector(`[data-entry-id="${CSS.escape(item.id)}"]`)).find(Boolean);
      tbody.insertBefore(replacement, next || null);
      initializeScrollableTableRow(replacement);
      bindDeliveryRowActions(replacement);
    }
  }
  if (changedIds === null) initializeScrollableTables(tbody.closest("table"));
  const emptyState = document.querySelector("#delivery-empty");
  if (isDeliveryRoleChipMode() && !filtered.length) {
    emptyState.replaceChildren();
    const options = deliveryRoleStatusLabels();
    if (!matchingRows.length) {
      emptyState.textContent = "No matching deliveries";
    } else {
      const current = options.find(({ value }) => value === deliveryRoleStatusFilter);
      emptyState.append(document.createTextNode(`No ${current?.label || "matching"} deliveries.`));
      const alternative = options.find(({ value }) => value !== deliveryRoleStatusFilter && value !== "all"
        && matchingRows.some((row) => deliveryRoleStatusMatches(row, value)));
      if (alternative) {
        const count = matchingRows.filter((row) => deliveryRoleStatusMatches(row, alternative.value)).length;
        emptyState.append(document.createElement("br"), document.createTextNode(`${count} in ${alternative.label}, `));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet production-ready-link";
        button.textContent = "view them";
        button.addEventListener("click", () => {
          deliveryRoleStatusFilter = alternative.value;
          renderDeliveryRows();
        });
        emptyState.append(button);
      }
    }
  } else if (page === "production-store.html" && !filtered.length) {
    emptyState.replaceChildren();
    if (!matchingRows.length) {
      emptyState.textContent = "No matching deliveries";
    } else {
      const selectedLabel = ({
        pending: "pending",
        ready: "ready",
        partial: "partially ready",
        not_ready: "not ready",
        all: "matching"
      })[productionGoodsFilter];
      emptyState.append(document.createTextNode(`No ${selectedLabel} deliveries.`));
      const readyCount = matchingRows.filter((row) => currentDeliveryGoodsStatus(row) === "ready").length;
      if (readyCount) {
        emptyState.append(document.createElement("br"), document.createTextNode(`${readyCount} are ready, `));
        const viewReady = document.createElement("button");
        viewReady.type = "button";
        viewReady.className = "quiet production-ready-link";
        viewReady.textContent = "view them";
        viewReady.addEventListener("click", () => {
          productionGoodsFilter = "ready";
          renderDeliveryRows();
        });
        emptyState.append(viewReady);
      }
    }
  } else if (page === "production-store.html" || isDeliveryRoleChipMode()) {
    emptyState.replaceChildren();
  } else {
    emptyState.textContent = page === "deliveries.html"
      ? "No deliveries match these filters."
      : "No delivery requests found.";
  }
  emptyState.classList.toggle("hidden", filtered.length > 0);
  if (page === "deliveries.html") {
    document.querySelector("#delivery-results-count").textContent = `Showing ${filtered.length} deliveries`;
    const activeFilters = [];
    const dateFrom = document.querySelector("#delivery-date-from").value;
    const dateTo = document.querySelector("#delivery-date-to").value;
    const salesperson = document.querySelector("#delivery-salesperson");
    const production = document.querySelector("#delivery-production-filter").value;
    const dispatch = document.querySelector("#delivery-dispatch-filter");
    const search = document.querySelector("#delivery-search").value.trim();
    if (dateFrom || dateTo) activeFilters.push(`Delivery date: ${dateFrom || "any"}–${dateTo || "any"}`);
    if (salesperson.value) activeFilters.push(`Salesperson: ${salesperson.selectedOptions[0].textContent}`);
    if (!isDeliveryRoleChipMode()) {
      if (production) activeFilters.push(`Production: ${production}`);
      if (dispatch.value) activeFilters.push(`Dispatch: ${dispatch.selectedOptions[0].textContent}`);
    }
    if (isDeliveryRoleChipMode()) {
      const selectedPill = deliveryRoleStatusLabels().find(({ value }) => value === deliveryRoleStatusFilter);
      if (selectedPill && selectedPill.value !== "all") activeFilters.push(`Status: ${selectedPill.label}`);
    }
    if (!isDeliveryRoleChipMode() && deliveryUrgentFilter) activeFilters.push("Status: Urgent");
    if (showBrandingFilter && deliveryBrandingFilter !== "all") {
      activeFilters.push(`Branding: ${deliveryBrandingFilter}`);
    }
    if (search) activeFilters.push(`Search: ${search}`);
    document.querySelector("#delivery-active-filters").textContent = activeFilters.length
      ? `Active filters: ${activeFilters.join(" · ")}`
      : "No active filters";
  }
  updateSortIndicators();
}

function renderDispatchDialog(row) {
  const content = document.querySelector("#dispatch-dialog-content");
  const message = document.querySelector("#dispatch-dialog-message");
  const items = Array.isArray(row.items) ? row.items : [];
  const trips = dispatchTripsByDelivery.get(row.id) || [];
  const openTrips = trips.filter((trip) =>
    !trip.voided_at && ["Packed", "Out for delivery"].includes(trip.status));
  const tripOptions = openTrips.map((trip) =>
    `<option value="${escapeHtml(trip.id)}"${dispatchDialogState.selectedTripId === trip.id ? " selected" : ""}>${escapeHtml(trip.vehicle)} · ${escapeHtml(trip.status)}</option>`
  ).join("");
  const newTripSelected = dispatchDialogState.selectedTripId === "new"
    || !openTrips.some((trip) => trip.id === dispatchDialogState.selectedTripId);
  if (newTripSelected) dispatchDialogState.selectedTripId = "new";
  const vehicleOptions = vehicleRows.map((vehicle) =>
    `<option value="${escapeHtml(vehicle.registration_number)}">${escapeHtml(vehicle.registration_number)} · ${escapeHtml(vehicle.description)}</option>`
  ).join("");
  const lineMarkup = items.map((item) => {
    const progress = dispatchItemProgress(row.id, item.item_key);
    const availableToReceive = progress?.available_to_receive ?? 0;
    const availableToPack = progress?.available_to_pack ?? 0;
    return `<section class="dispatch-dialog-line">
      <h3>${escapeHtml(item.so_number || "—")} · ${escapeHtml(item.item_name || "Item")}</h3>
      <p>Received ${escapeHtml(progress?.received ?? "—")}/${escapeHtml(progress?.job_card_total ?? "—")} · Packed ${escapeHtml(progress?.packed ?? "—")} · Delivered ${escapeHtml(progress?.delivered ?? "—")}</p>
      <div class="dispatch-dialog-actions">
        <label>Receive<input type="number" min="1" max="${escapeHtml(availableToReceive)}" value="${escapeHtml(availableToReceive)}" data-dispatch-receive-qty="${escapeHtml(item.item_key)}"></label>
        <button type="button" class="secondary" data-dispatch-action="receive" data-item-key="${escapeHtml(item.item_key)}">Receive quantity</button>
        <button type="button" class="quiet" data-dispatch-action="receive-all" data-item-key="${escapeHtml(item.item_key)}"${availableToReceive ? "" : " disabled"}>Receive all available</button>
      </div>
      <div class="dispatch-dialog-actions">
        <label>Pack<input type="number" min="1" max="${escapeHtml(availableToPack)}" value="${escapeHtml(availableToPack)}" data-dispatch-pack-qty="${escapeHtml(item.item_key)}"></label>
        <button type="button" class="secondary" data-dispatch-action="pack" data-item-key="${escapeHtml(item.item_key)}"${availableToPack ? "" : " disabled"}>Pack to trip</button>
      </div>
    </section>`;
  }).join("");
  const tripMarkup = trips.filter((trip) => !trip.voided_at).map((trip) => {
    const tripItems = dispatchTripItemsByTripId.get(trip.id) || [];
    const lineInputs = tripItems.map((tripItem) => {
      const item = items.find((line) => line.item_key === tripItem.item_key);
      return `<label>${escapeHtml(item?.item_name || "Item")} · Packed ${escapeHtml(tripItem.qty_packed)}
        <input type="number" min="0" max="${escapeHtml(tripItem.qty_packed)}" value="${escapeHtml(tripItem.qty_packed)}" data-dispatch-delivery-qty data-item-key="${escapeHtml(tripItem.item_key)}">
      </label>`;
    }).join("");
    const defaultAddress = tripItems.map((tripItem) =>
      items.find((line) => line.item_key === tripItem.item_key)?.address).find((address) => String(address || "").trim()) || "";
    const isOpen = ["Packed", "Out for delivery"].includes(trip.status);
    return `<section class="dispatch-dialog-trip" data-dispatch-trip="${escapeHtml(trip.id)}">
      <h3>${escapeHtml(trip.vehicle)} · ${escapeHtml(trip.status)}</h3>
      ${tripItems.map((tripItem) => {
        const item = items.find((line) => line.item_key === tripItem.item_key);
        return `<p>${escapeHtml(item?.item_name || "Item")} · Packed ${escapeHtml(tripItem.qty_packed)} · Delivered ${escapeHtml(tripItem.qty_delivered)}</p>`;
      }).join("")}
      ${isOpen ? `<label>Delivery date<input type="date" value="${escapeHtml(today())}" data-dispatch-delivered-on required></label>
        <label>Delivery address<input type="text" value="${escapeHtml(defaultAddress)}" data-dispatch-address required></label>
        ${lineInputs}
        <button type="button" class="primary" data-dispatch-action="deliver" data-trip-id="${escapeHtml(trip.id)}">Deliver trip</button>
        <label>Failure reason<input type="text" data-dispatch-fail-reason="${escapeHtml(trip.id)}" required></label>
        <button type="button" class="danger" data-dispatch-action="fail" data-trip-id="${escapeHtml(trip.id)}">Fail trip</button>` : ""}
    </section>`;
  }).join("");
  content.innerHTML = `<section>
    <h3>Receive and pack by item</h3>
    ${lineMarkup || '<p class="muted">No item lines.</p>'}
  </section>
  <section>
    <h3>Pack to trip</h3>
    <label>Trip<select id="dispatch-trip-choice">
      <option value="new"${newTripSelected ? " selected" : ""}>New trip</option>${tripOptions}
    </select></label>
    <div id="dispatch-new-trip-fields"${newTripSelected ? "" : " hidden"}>
      <label>Vehicle<input type="text" list="dispatch-vehicle-options" value="${escapeHtml(dispatchDialogState.vehicle)}" data-dispatch-vehicle required></label>
      <datalist id="dispatch-vehicle-options">${vehicleOptions}</datalist>
      <label>Rider ID (optional)<input type="text" value="${escapeHtml(dispatchDialogState.riderId)}" data-dispatch-rider></label>
      <label>Trip note (optional)<input type="text" value="${escapeHtml(dispatchDialogState.note)}" data-dispatch-note></label>
    </div>
  </section>
  <section><h3>Trips</h3>${tripMarkup || '<p class="muted">No trips yet.</p>'}</section>
  ${profile.role === "admin" ? '<section><h3>Close with balance</h3><label>Reason<input type="text" data-dispatch-close-reason required></label><button type="button" class="danger" data-dispatch-action="close">Close with balance</button></section>' : ""}`;
  message.textContent = "";
  document.querySelector("#dispatch-dialog-title").textContent = `Dispatch · ${row.ref_no || row.sr || row.client_name || "Delivery"}`;
  const tripChoice = document.querySelector("#dispatch-trip-choice");
  tripChoice.addEventListener("change", () => {
    dispatchDialogState.selectedTripId = tripChoice.value;
    document.querySelector("#dispatch-new-trip-fields").hidden = tripChoice.value !== "new";
  });
  content.querySelector("[data-dispatch-vehicle]")?.addEventListener("input", (event) => {
    dispatchDialogState.vehicle = event.target.value;
  });
  content.querySelector("[data-dispatch-rider]")?.addEventListener("input", (event) => {
    dispatchDialogState.riderId = event.target.value;
  });
  content.querySelector("[data-dispatch-note]")?.addEventListener("input", (event) => {
    dispatchDialogState.note = event.target.value;
  });
}

function openDispatchDialog(row, trigger) {
  dispatchDialogState = {
    deliveryId: row.id,
    selectedTripId: "new",
    vehicle: "",
    riderId: "",
    note: "",
    trigger
  };
  renderDispatchDialog(row);
  const dialog = document.querySelector("#dispatch-dialog");
  if (!dialog.open) dialog.showModal();
}

async function runDispatchAction(button) {
  const dialog = document.querySelector("#dispatch-dialog");
  const deliveryId = dispatchDialogState.deliveryId;
  const row = deliveryRows.find((delivery) => delivery.id === deliveryId);
  if (!row) return;
  const action = button.dataset.dispatchAction;
  const itemKey = button.dataset.itemKey;
  const tripId = button.dataset.tripId;
  let rpcName;
  let args;
  if (action === "receive" || action === "receive-all") {
    const input = dialog.querySelector(`[data-dispatch-receive-qty="${CSS.escape(itemKey)}"]`);
    rpcName = "receive_item";
    args = {
      p_delivery_id: deliveryId,
      p_item_key: itemKey,
      p_qty: action === "receive-all" ? null : Number(input.value),
      p_note: null
    };
  } else if (action === "pack") {
    const input = dialog.querySelector(`[data-dispatch-pack-qty="${CSS.escape(itemKey)}"]`);
    const useNewTrip = dispatchDialogState.selectedTripId === "new";
    const vehicle = dialog.querySelector("[data-dispatch-vehicle]")?.value.trim() || "";
    if (useNewTrip && !vehicle) {
      dialog.querySelector("#dispatch-dialog-message").textContent = "A vehicle is required for a new trip.";
      return;
    }
    rpcName = "pack_to_trip";
    args = {
      p_delivery_id: deliveryId,
      p_item_key: itemKey,
      p_qty: Number(input.value),
      p_trip_id: useNewTrip ? null : dispatchDialogState.selectedTripId,
      p_vehicle: useNewTrip ? vehicle : null,
      p_rider_id: useNewTrip ? dialog.querySelector("[data-dispatch-rider]")?.value.trim() || null : null,
      p_note: useNewTrip ? dialog.querySelector("[data-dispatch-note]")?.value.trim() || null : null
    };
  } else if (action === "deliver") {
    const trip = button.closest("[data-dispatch-trip]");
    const date = trip.querySelector("[data-dispatch-delivered-on]").value;
    const address = trip.querySelector("[data-dispatch-address]").value.trim();
    if (!date || !address) {
      dialog.querySelector("#dispatch-dialog-message").textContent = "A delivery date and address are required.";
      return;
    }
    const quantities = {};
    trip.querySelectorAll("[data-dispatch-delivery-qty]").forEach((input) => {
      quantities[input.dataset.itemKey] = Number(input.value);
    });
    rpcName = "deliver_trip";
    args = {
      p_trip_id: tripId,
      p_delivered_on: date,
      p_delivery_address: address,
      p_qty_per_item: quantities
    };
  } else if (action === "fail") {
    const reason = dialog.querySelector(`[data-dispatch-fail-reason="${CSS.escape(tripId)}"]`).value.trim();
    if (!reason) {
      dialog.querySelector("#dispatch-dialog-message").textContent = "A failure reason is required.";
      return;
    }
    rpcName = "fail_trip";
    args = { p_trip_id: tripId, p_reason: reason };
  } else if (action === "close") {
    const reason = dialog.querySelector("[data-dispatch-close-reason]").value.trim();
    if (!reason) {
      dialog.querySelector("#dispatch-dialog-message").textContent = "A close-with-balance reason is required.";
      return;
    }
    rpcName = "close_with_balance";
    args = { p_delivery_id: deliveryId, p_reason: reason };
  } else {
    return;
  }
  const buttons = [...dialog.querySelectorAll("button")];
  buttons.forEach((current) => { current.disabled = true; });
  dialog.querySelector("#dispatch-dialog-message").textContent = "";
  let actionCompleted = false;
  try {
    const { data, error } = await client.rpc(rpcName, args);
    if (error) throw error;
    actionCompleted = true;
    if (rpcName === "pack_to_trip" && dispatchDialogState.selectedTripId === "new") {
      dispatchDialogState.selectedTripId = data;
    }
    await loadDispatchProgress([deliveryId]);
    renderDeliveryRows(new Set([deliveryId]));
    const refreshedRow = deliveryRows.find((delivery) => delivery.id === deliveryId);
    if (refreshedRow) renderDispatchDialog(refreshedRow);
    buttons.forEach((current) => { current.disabled = false; });
  } catch (error) {
    dialog.querySelector("#dispatch-dialog-message").textContent = actionCompleted
      ? `Action completed, but progress could not be refreshed: ${error.message || "Please reload the page."}`
      : error.message || "The dispatch action could not be completed.";
    buttons.forEach((current) => {
      current.disabled = actionCompleted && !current.matches("[data-dispatch-close]");
    });
  }
}

function bindDispatchDialog() {
  const dialog = document.querySelector("#dispatch-dialog");
  dialog.querySelector("[data-dispatch-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
    const button = event.target.closest("[data-dispatch-action]");
    if (button) void runDispatchAction(button);
  });
  dialog.addEventListener("close", () => {
    if (dispatchDialogState.trigger?.isConnected) dispatchDialogState.trigger.focus();
    dispatchDialogState.deliveryId = null;
  });
}

function bindDeliveryRowActions(root) {
  root.querySelectorAll("[data-delivery-ready]").forEach((button) => button.addEventListener("click", () =>
    updateDelivery(button.dataset.deliveryReady, {
      production_status: "Ready",
      ...(profile.role === "admin" ? { ready_at: new Date().toISOString() } : {})
    }, button, "Delivery marked Ready.")));
  root.querySelectorAll("[data-delivery-view]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.deliveryView);
    if (row) void openDeliveryView(row, button);
  }));
  root.querySelectorAll("[data-delivery-edit]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.deliveryEdit);
    if (row) openDeliveryEdit(row);
  }));
  root.querySelectorAll("[data-production-edit]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.productionEdit);
    if (row) openProductionDeliveryEdit(row);
  }));
  root.querySelectorAll("tr[data-production-entry-edit]").forEach((tableRow) => {
    const open = () => {
      const row = deliveryRows.find((item) => item.id === tableRow.dataset.entryId);
      if (row) openProductionDeliveryEdit(row);
    };
    tableRow.addEventListener("click", (event) => {
      if (event.target.closest("button,a,input,select,textarea,[data-delivery-items]")) return;
      open();
    });
    tableRow.addEventListener("keydown", (event) => {
      if (event.target !== tableRow || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      open();
    });
  });
  root.querySelectorAll("[data-delivery-delete]").forEach((button) => button.addEventListener("click", () => {
    void deleteDelivery(button);
  }));
  root.querySelectorAll("[data-dispatch-open]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.dispatchOpen);
    if (row) openDispatchDialog(row, button);
  }));
  root.querySelectorAll("[data-release-history]").forEach((button) => button.addEventListener("click", () => {
    void openReleaseHistory(button.dataset.releaseHistory, button).catch((error) =>
      toast(error.message || "Could not load release history.", "error"));
  }));
  root.querySelectorAll("[data-delivery-items]").forEach((cell) => {
    const open = () => {
      const row = deliveryRows.find((item) => item.id === cell.dataset.deliveryItems);
      if (row) openDeliveryItemsView(row, cell);
    };
    cell.addEventListener("click", open);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  root.querySelectorAll("[data-transport]").forEach((select) => select.addEventListener("change", async () => {
    const vehicle = root.querySelector(`[data-vehicle="${CSS.escape(select.dataset.transport)}"]`);
    vehicle?.classList.toggle("hidden", select.value !== "Company");
    if (vehicle && select.value !== "Company") vehicle.value = "";
    select.disabled = true;
    await updateDelivery(select.dataset.transport, {
      transport: select.value || null,
      vehicle_id: select.value === "Company" ? vehicle?.value || null : null
    }, null, "Transport saved.");
    if (select.isConnected) select.disabled = false;
  }));
  root.querySelectorAll("[data-vehicle]").forEach((select) => select.addEventListener("change", async () => {
    select.disabled = true;
    await updateDelivery(select.dataset.vehicle, {
      vehicle_id: select.value || null
    }, null, "Vehicle saved.");
    if (select.isConnected) select.disabled = false;
  }));
}

async function deleteDelivery(button) {
  const id = button.dataset.deliveryDelete;
  const row = deliveryRows.find((delivery) => delivery.id === id);
  if (profile?.role !== "admin" || !id || !row) return;
  if (!confirm(`Delete delivery ${row.ref_no} (${row.client_name || "no client"})? This cannot be undone.`)) return;
  setBusy(button, true, "Deleting…");
  try {
    const { error } = await client.rpc("admin_delete_delivery", { p_delivery_id: id });
    if (error) throw error;
  } catch (error) {
    toast(error.message || "Could not delete the delivery.", "error");
    return;
  } finally {
    setBusy(button, false);
  }
  deliveryRowsVersion += 1;
  deliveryRows = deliveryRows.filter((delivery) => delivery.id !== id);
  renderDeliveryRows([id]);
  toast(`Delivery ${row.ref_no} deleted.`);
  document.querySelector("#delivery-period").dispatchEvent(new Event("change"));
}

export async function openDeliveryFromDeepLink(id) {
  const cleanUrl = () => {
    const url = new URL(location.href);
    url.searchParams.delete("open");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  try {
    document.querySelector("#delivery-search").value = "";
    deliveryUrgentFilter = false;
    if (page === "production-store.html") {
      document.querySelector("#production-salesperson-filter").value = "";
      productionGoodsFilter = "all";
    } else {
      document.querySelector("#delivery-date-from").value = "";
      document.querySelector("#delivery-date-to").value = "";
      document.querySelector("#delivery-salesperson").value = "";
      document.querySelector("#delivery-production-filter").value = "";
      document.querySelector("#delivery-dispatch-filter").value = "";
      const statusFilter = document.querySelector("#delivery-status-filter");
      if (statusFilter) statusFilter.value = "";
      if (isDeliveryRoleChipMode()) deliveryRoleStatusFilter = "all";
      saveDeliveryFilters();
    }
    renderDeliveryRows();

    let row = deliveryRows.find((delivery) => delivery.id === id);
    if (!row) {
      const { data, error } = await client.from(deliveryReadTable())
        .select(deliverySelect).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) {
        toast("That request is not available here", "error");
        return;
      }
      row = data;
      deliveryRows.push(row);
      if (page === "production-store.html") {
        await loadProductionStoreProgress([id]);
        await loadProductionStoreSalespeople();
      }
    }

    renderDeliveryRows();
    const tableRow = document.querySelector(`#delivery-rows [data-entry-id="${CSS.escape(id)}"]`);
    const trigger = tableRow?.querySelector(`[data-delivery-view="${CSS.escape(id)}"]`);
    if (!tableRow || !trigger) {
      toast("That request is not available here", "error");
      return;
    }
    tableRow.classList.add("portal-opened-entry");
    tableRow.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => tableRow.classList.remove("portal-opened-entry"), 2000);
    await openDeliveryView(row, trigger);
  } finally {
    cleanUrl();
  }
}

async function openReleaseHistory(deliveryId, trigger) {
  const { data: entries, error } = await client.from("store_release_logs")
    .select("qty,done_on,user_id,note,voided_at,void_reason")
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const userIds = [...new Set((entries || []).map((entry) => entry.user_id))];
  const users = await loadDeliveryProfiles(userIds);
  const names = new Map(users.map((user) => [user.id, user.full_name]));
  const content = document.querySelector("#release-history-content");
  content.innerHTML = entries?.length
    ? `<table><thead><tr><th>Date</th><th>Quantity</th><th>User</th><th>Note</th></tr></thead><tbody>${entries.map((entry) => `
      <tr>
        <td>${escapeHtml(localDate(entry.done_on))}</td>
        <td>${escapeHtml(entry.qty)}</td>
        <td>${escapeHtml(names.get(entry.user_id) || "Unknown user")}</td>
        <td>${entry.voided_at
          ? `Voided: ${escapeHtml(entry.void_reason || "—")}`
          : escapeHtml(entry.note || "—")}</td>
      </tr>`).join("")}</tbody></table>`
    : '<p class="muted">No release history for this entry.</p>';
  const dialog = document.querySelector("#release-history-dialog");
  dialog.querySelectorAll("[data-release-history-close]").forEach((button) => {
    button.onclick = () => dialog.close();
  });
  dialog.onclose = () => { if (trigger?.isConnected) trigger.focus(); };
  dialog.onclick = (event) => {
    if (event.target === dialog) dialog.close();
  };
  if (!dialog.open) dialog.showModal();
}

function openDeliveryItemsView(row, trigger) {
  const items = Array.isArray(row.items) ? row.items : [];
  const soNumbers = deliverySoNumbers(row);
  const content = document.querySelector("#delivery-items-view-content");
  const goodsStatusColumn = page === "production-store.html" || deliveryEditId;
  const productionStore = page === "production-store.html";
  const heading = productionStore ? "" : `<h3>SO number(s)</h3><p>${soNumbers.length ? soNumbers.map(escapeHtml).join(", ") : "—"}</p>`;
  const headers = productionStore
    ? "<tr><th>SO number</th><th>Item details</th></tr>"
    : `<tr><th>SO number</th><th>Item name</th><th>Quantity (pcs)</th><th>Address to deliver</th>${goodsStatusColumn ? "<th>Goods status</th>" : ""}</tr>`;
  content.innerHTML = `${heading}<table><thead>${headers}</thead><tbody>${items.map((item) => {
    const progress = productionStore ? productionItemProgress(row.id, item.item_key) : null;
    return productionStore
      ? `<tr><td>${escapeHtml(item.so_number || "—")}</td><td>${escapeHtml(`${item.item_name || "Item"} ${progress ? `${progress.released}/${progress.job_card_total}` : "—/—"`)}</td></tr>`
      : `<tr><td>${escapeHtml(item.so_number)}</td><td>${escapeHtml(item.item_name)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(item.address)}</td>${goodsStatusColumn ? `<td>${escapeHtml(deliveryGoodsStatusLabel(item.goods_status))}</td>` : ""}</tr>`;
  }).join("")}</tbody></table>`;
  initializeScrollableTables(content.querySelector("table"));
  const dialog = document.querySelector("#delivery-items-view-dialog");
  const close = () => dialog.close();
  dialog.querySelectorAll("[data-items-view-close]").forEach((button) => { button.onclick = close; });
  dialog.onclose = () => { if (trigger.isConnected) trigger.focus(); };
  dialog.onclick = (event) => {
    if (event.target === dialog) close();
  };
  dialog.showModal();
}

async function openDeliveryView(row, trigger) {
  document.dispatchEvent(new CustomEvent("portal:mark-entry-read", { detail: row.id }));
  let requestedBy = profile.full_name;
  const salespersonId = row.salesperson_id || row.created_by;
  if (salespersonId) {
    try {
      const [salesperson] = await loadDeliveryProfiles([salespersonId]);
      if (salesperson?.full_name) requestedBy = salesperson.full_name;
    } catch (error) {
      toast(error.message || "Could not load the salesperson name.", "error");
      return;
    }
  }
  let vehicleName = vehicleRows.find((vehicle) => vehicle.id === row.vehicle_id)?.registration_number || "—";
  if (row.vehicle_id && vehicleName === "—") {
    try {
      vehicleName = await loadDeliveryVehicleName(row.vehicle_id);
    } catch (error) {
      toast(error.message || "Could not load the vehicle details.", "error");
      return;
    }
  }
  const items = Array.isArray(row.items) ? row.items : [];
  const addresses = deliveryAddress(row);
  const soNumbers = deliverySoNumbers(row);
  const content = document.querySelector("#delivery-view-content");
  content.innerHTML = `<dl class="delivery-detail-grid">
    <div><dt>Reference number</dt><dd>${escapeHtml(row.ref_no)}</dd></div>
    <div><dt>Requested by</dt><dd>${escapeHtml(requestedBy)}</dd></div>
    <div><dt>Time requested</dt><dd>${escapeHtml(localDateTime(row.created_at))}</dd></div>
    <div><dt>Client</dt><dd>${escapeHtml(row.client_name)}</dd></div>
    <div><dt>Delivery address</dt><dd>${escapeHtml(addresses || "—")}</dd></div>
    ${hasProductionAccess(profile) || hasDispatchAccess(profile) ? "" : `<div><dt>Contact name</dt><dd>${escapeHtml(row.contact_name)}</dd></div>
    <div><dt>Contact number</dt><dd>${escapeHtml(row.contact_number)}</dd></div>`}
    <div><dt>Delivery date and time</dt><dd>${escapeHtml(row.delivery_date || "—")} · ${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}</dd></div>
    <div><dt>Mode of branding</dt><dd>${escapeHtml(deliveryBrandingModes(row).join(", ") || "—")}</dd></div>
    <div><dt>Special instruction</dt><dd>${escapeHtml(row.special_instruction || "—")}</dd></div>
  </dl>
  <h3>SO number(s)</h3><p>${soNumbers.length ? soNumbers.map(escapeHtml).join(", ") : "—"}</p>
  <h3>Items</h3><div class="table-wrap"><table><thead><tr><th>SO number</th><th>Item name</th><th>Quantity (pcs)</th><th>Address</th></tr></thead><tbody>${items.map((item) =>
    `<tr><td>${escapeHtml(item.so_number)}</td><td>${escapeHtml(item.item_name)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(item.address)}</td></tr>`
  ).join("")}</tbody></table></div>
  <dl class="delivery-detail-grid">
    <div><dt>Production status</dt><dd>${escapeHtml(row.production_status)}${row.ready_at ? ` · ${escapeHtml(localDateTime(row.ready_at))}` : ""}</dd></div>
    <div><dt>Dispatch status</dt><dd>${escapeHtml(row.dispatch_status)}</dd></div>
    <div><dt>Transport</dt><dd>${escapeHtml(row.transport || "—")}</dd></div>
    <div><dt>Vehicle</dt><dd>${escapeHtml(vehicleName)}</dd></div>
    <div><dt>Dispatched</dt><dd>${escapeHtml(localDateTime(row.dispatched_at))}</dd></div>
    <div><dt>Delivered</dt><dd>${escapeHtml(localDateTime(row.delivered_at))}</dd></div>
  </dl>`;
  content.querySelectorAll("table").forEach((table) => initializeScrollableTables(table));
  const dialog = document.querySelector("#delivery-view-dialog");
  const close = dialog.querySelector("[data-delivery-view-close]");
  close.onclick = () => dialog.close();
  dialog.onclose = () => { if (trigger.isConnected) trigger.focus(); };
  dialog.showModal();
  close.focus();
}

async function updateDelivery(id, values, button, success) {
  setBusy(button, true);
  try {
    const { data, error } = await client.from("deliveries").update(values).eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This delivery could not be updated. Refresh and try again.");
    toast(success);
    try {
      await patchDeliveryRowsById([id]);
    } catch (error) {
      toast(`Updated, but the delivery list could not refresh: ${error.message || "unknown error"}`, "error");
    }
  } catch (error) {
    toast(error.message || "Could not update this delivery.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function refreshAssignedPendingDeliveries() {
  const notice = document.querySelector("#delivery-handoff-notice");
  if (page !== "deliveries.html" || profile.role !== "salesperson") {
    notice?.classList.add("hidden");
    assignedPendingDeliveries = [];
    return;
  }
  assignedPendingDeliveries = deliveryRows.filter((row) =>
    (row.salesperson_id || row.created_by) === profile.id
    && (row.handoff_status === "pending_details" || deliveryDetailsNeeded(row))
    && row.dispatch_status !== "Delivered" && !row.delivered_at);
  const pendingCount = assignedPendingDeliveries.length;
  notice.textContent = pendingCount === 1
    ? "1 production request is waiting for your details"
    : `${pendingCount} production requests are waiting for your details`;
  notice.classList.toggle("hidden", pendingCount === 0);
  notice.setAttribute("aria-label", notice.textContent);
}

function deliveryPopupState(storageKey) {
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) return {};
  const state = JSON.parse(saved);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`Invalid ${storageKey} session state.`);
  }
  return state;
}

function deliveryWaitDuration(createdAt) {
  const elapsed = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const days = Math.floor(elapsed / 86400000);
  const hours = Math.floor((elapsed % 86400000) / 3600000);
  if (days) return `${days}d ${hours}h`;
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function refreshUrgentDeliveryAlerts() {
  if (page !== "deliveries.html" || profile.role !== "salesperson") {
    urgentDeliveryRows = [];
    return;
  }
  try {
    urgentDeliveryRows = deliveryRows.filter((row) =>
      (row.salesperson_id || row.created_by) === profile.id && deliveryDetailsNeeded(row));
    urgentDeliveryRows.sort((left, right) =>
      Number(deliveryAddressUrgent(right)) - Number(deliveryAddressUrgent(left))
      || new Date(left.created_at) - new Date(right.created_at));
    const activeKeys = new Set(urgentDeliveryRows.map((row) =>
      `${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`));
    deliveryPopupShownKeys.forEach((key) => {
      if (!activeKeys.has(key)) deliveryPopupShownKeys.delete(key);
    });
    const snoozed = deliveryPopupState("deliveryDetailsPopupSnoozeById");
    const now = Date.now();
    const visibleRows = urgentDeliveryRows.filter((row) => {
      const key = `${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`;
      return Number(snoozed[key] || 0) <= now;
    });
    const dialog = document.querySelector("#urgent-deliveries-dialog");
    const list = document.querySelector("#urgent-deliveries-list");
    list.innerHTML = visibleRows.map((row) => `<article class="urgent-delivery-item"${deliveryAddressUrgent(row) ? ' data-urgent="true"' : ""}>
      <div><strong>${deliveryAddressUrgent(row) ? "URGENT · " : ""}${escapeHtml(row.client_name || "—")}</strong><span>SO ${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</span><span>Delivery ${escapeHtml(row.delivery_date || "—")}</span><span>Waiting ${escapeHtml(deliveryWaitDuration(row.created_at))}</span></div>
      <button type="button" class="primary" data-fill-urgent-delivery="${escapeHtml(row.id)}">Fill now</button>
    </article>`).join("");
    if (!urgentDeliveryRows.length) {
      if (dialog.open) dialog.close();
      return;
    }
    const newlyVisible = visibleRows.filter((row) => {
      const key = `${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`;
      return !deliveryPopupShownKeys.has(key);
    });
    const urgentVisible = visibleRows.filter(deliveryAddressUrgent);
    const urgentReminderReady = urgentVisible.length > 0
      && (!urgentPopupLastShownAt || now - urgentPopupLastShownAt >= 60 * 60 * 1000);
    if (!newlyVisible.length && !urgentReminderReady) return;
    newlyVisible.forEach((row) => {
      const key = `${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`;
      deliveryPopupShownKeys.add(key);
    });
    if (urgentReminderReady) urgentPopupLastShownAt = now;
    if (dialog.open) return;
    dialog.showModal();
  } catch (error) {
    toast(error.message || "Could not update the details-needed reminder.", "error");
  }
}

function bindUrgentDeliveryPopup() {
  const dialog = document.querySelector("#urgent-deliveries-dialog");
  if (!dialog || profile.role !== "salesperson") return;
  dialog.querySelectorAll("[data-close-urgent-deliveries]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.querySelector("[data-remind-urgent-deliveries]").addEventListener("click", () => {
    dialog.close();
    const snoozed = deliveryPopupState("deliveryDetailsPopupSnoozeById");
    const snoozeUntil = Date.now() + 60 * 60 * 1000;
    urgentDeliveryRows.forEach((row) => {
      const key = `${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`;
      snoozed[key] = snoozeUntil;
    });
    sessionStorage.setItem("deliveryDetailsPopupSnoozeById", JSON.stringify(snoozed));
    urgentDeliveryRows.forEach((row) => {
      deliveryPopupShownKeys.delete(`${row.id}:${deliveryAddressUrgent(row) ? "urgent" : "details"}`);
    });
    urgentPopupLastShownAt = Date.now();
  });
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("[data-fill-urgent-delivery]");
    if (!button) return;
    const row = urgentDeliveryRows.find((item) => item.id === button.dataset.fillUrgentDelivery);
    if (!row || !canSalespersonEditDelivery(row)) {
      toast("That request is no longer available for editing.", "error");
      return;
    }
    dialog.close();
    openDeliveryEdit(row);
  });
}

function openFirstAssignedPendingDelivery() {
  const first = assignedPendingDeliveries[0];
  if (!first) return;
  document.querySelector("#delivery-search").value = "";
  assignedPendingDeliveries.forEach((row) => {
    if (!deliveryRows.some((existing) => existing.id === row.id)) deliveryRows.push(row);
  });
  renderDeliveryRows();
  const tableRow = document.querySelector(`#delivery-rows [data-entry-id="${CSS.escape(first.id)}"]`);
  if (tableRow) {
    tableRow.classList.add("portal-new-row");
    tableRow.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export async function initDeliveries({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  const requestPanel = document.querySelector("#delivery-request-panel");
  const productionEntry = isProductionStoreMode();
  if (!productionEntry && profile.role !== "salesperson" && profile.role !== "admin") requestPanel.classList.add("hidden");
  else {
    const form = document.querySelector("#delivery-request-form");
    setupDeliveryBrandingPicker(form);
    document.querySelector("#delivery-salesperson-field")?.classList.toggle("hidden", !productionEntry);
    configureDeliveryForm(form, productionEntry);
    const clientInput = form.elements.client_name;
    const contactNameInput = form.elements.contact_name;
    const contactNumberInput = form.elements.contact_number;
    const clientSuggestions = document.querySelector("#delivery-client-suggestions");
    const contactSuggestions = document.querySelector("#delivery-contact-suggestions");
    let contactNameEdited = false;
    let contactNumberEdited = false;
    const clearClientDefaults = () => {
      if (!contactNameEdited && deliveryAutofilledContactName
        && contactNameInput.value === deliveryAutofilledContactName) contactNameInput.value = "";
      if (!contactNumberEdited && deliveryAutofilledContactNumber
        && contactNumberInput.value === deliveryAutofilledContactNumber) contactNumberInput.value = "";
      deliveryItemsState.lines.forEach((line) => {
        if (deliveryAutofilledAddressLines.has(line)) {
          line.address = "";
          deliveryAutofilledAddressLines.delete(line);
        }
      });
      deliveryClientDefaults = { client: "", contacts: [], addresses: [] };
      deliveryAutofilledContactName = "";
      deliveryAutofilledContactNumber = "";
      contactSuggestions?.replaceChildren();
    };
    contactNameInput.addEventListener("input", () => { contactNameEdited = true; });
    contactNumberInput.addEventListener("input", () => { contactNumberEdited = true; });
    clientInput.addEventListener("input", () => {
      if (deliveryEditId || productionEditId) return;
      clearDeliveryItemConflictState();
      if (deliveryClientDefaults.client && deliveryClientDefaults.client !== clientInput.value.trim()) {
        clearClientDefaults();
      }
      clearTimeout(deliveryClientSuggestionsTimer);
      const search = clientInput.value.trim();
      clientSuggestions?.replaceChildren();
      if (search.length < 2) return;
      deliveryClientSuggestionsTimer = setTimeout(async () => {
        let result;
        try {
          result = await client.rpc("delivery_client_suggestions", { p_search: search });
        } catch {
          return;
        }
        const { data, error } = result;
        if (error || deliveryEditId || productionEditId || clientInput.value.trim() !== search) return;
        (data ?? []).forEach((row) => {
          const option = document.createElement("option");
          option.value = row.client_name;
          clientSuggestions.append(option);
        });
      }, 250);
    });
    clientInput.addEventListener("change", async () => {
      if (deliveryEditId || productionEditId) return;
      const clientName = clientInput.value.trim();
      if (deliveryClientDefaults.client !== clientName) clearClientDefaults();
      deliveryClientDefaults = { client: clientName, contacts: [], addresses: [] };
      if (!clientName) return;
      let result;
      try {
        result = await client.rpc("delivery_client_defaults", { p_client: clientName });
      } catch {
        return;
      }
      const { data, error } = result;
      if (error || deliveryEditId || productionEditId || clientInput.value.trim() !== clientName) return;
      const rows = data ?? [];
      const contacts = rows.filter((row) => row.kind === "contact");
      const addresses = rows.filter((row) => row.kind === "address").map((row) => row.value);
      deliveryClientDefaults = { client: clientName, contacts, addresses };
      contactSuggestions.replaceChildren();
      contacts.forEach((contact) => {
        const option = document.createElement("option");
        option.value = contact.value;
        contactSuggestions.append(option);
      });
      const newestContact = contacts[0];
      if (newestContact?.value && !contactNameInput.value && !contactNameEdited) {
        contactNameInput.value = newestContact.value;
        deliveryAutofilledContactName = newestContact.value;
        contactNameEdited = false;
      }
      if (newestContact?.contact_number && !contactNumberInput.value && !contactNumberEdited) {
        contactNumberInput.value = newestContact.contact_number;
        deliveryAutofilledContactNumber = newestContact.contact_number;
        contactNumberEdited = false;
      }
    });
    contactNameInput.addEventListener("change", () => {
      if (deliveryEditId || productionEditId || contactNumberInput.value
        || deliveryClientDefaults.client !== clientInput.value.trim()) return;
      const contact = deliveryClientDefaults.contacts.find((entry) =>
        entry.value.toLowerCase() === contactNameInput.value.toLowerCase());
      if (contact?.contact_number) {
        contactNumberInput.value = contact.contact_number;
        deliveryAutofilledContactNumber = contact.contact_number;
        contactNumberEdited = false;
      }
    });
    if (productionEntry) await loadDeliverySalespeople();
    form.elements.delivery_date.removeAttribute("min");
    updateDeliverySlotOptions();
    form.elements.delivery_date.addEventListener("change", updateDeliverySlotOptions);
    document.querySelector("#delivery-form-toggle").addEventListener("click", () => {
      if (productionEditId) {
        closeProductionDeliveryEdit();
        return;
      }
      if (!deliveryEditId) deliveryOriginalItemPairs = null;
      form.classList.toggle("hidden");
      document.querySelector("#delivery-form-toggle").textContent = form.classList.contains("hidden") ? "New request" : "Close request";
    });
    form.addEventListener("submit", submitDelivery);
    form.addEventListener("reset", () => {
      clearTimeout(deliveryClientSuggestionsTimer);
      clearClientDefaults();
      clearDeliveryItemConflictState();
      clientSuggestions?.replaceChildren();
      contactNameEdited = false;
      contactNumberEdited = false;
      setTimeout(() => {
        document.querySelector('[name="items"]').value = "[]";
        document.querySelector("#delivery-items-open").textContent = "Click to add item details";
        setDeliveryBrandingSelection(form, []);
      });
    });
    if (page === "deliveries.html") {
      form.querySelector(".form-actions [type='reset']").addEventListener("click", (event) => {
        if (deliveryEditId) {
          event.preventDefault();
          closeDeliveryEdit();
        }
      });
    } else if (productionEntry) {
      form.querySelector('[type="reset"]').addEventListener("click", (event) => {
        if (productionEditId) {
          event.preventDefault();
          closeProductionDeliveryEdit();
        }
      });
    }
    document.querySelector("#delivery-items-open").addEventListener("click", openDeliveryItems);
  }
  if (page === "deliveries.html") {
    configureDeliveryTableHeaders();
    document.querySelector("#delivery-handoff-notice").addEventListener("click", openFirstAssignedPendingDelivery);
    bindUrgentDeliveryPopup();
    document.querySelector("[data-delivery-edit-cancel]").addEventListener("click", closeDeliveryEdit);
    document.querySelector("#delivery-edit-dialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDeliveryEdit();
    });
  }
  if (isDispatchScreen()) {
    bindDispatchDialog();
    await loadActiveVehicles();
  }
  const searchInput = document.querySelector("#delivery-search");
  searchInput.addEventListener("input", debounce(renderDeliveryRows, 200));
  if (page === "production-store.html") {
    const salespersonFilter = document.querySelector("#production-salesperson-filter");
    const partialReleaseDialog = document.querySelector("#partial-release-dialog");
    const editDialog = document.querySelector("#delivery-edit-dialog");
    document.querySelector("[data-partial-release-cancel]").addEventListener("click", () => partialReleaseDialog.close());
    partialReleaseDialog.addEventListener("click", (event) => {
      if (event.target === partialReleaseDialog) partialReleaseDialog.close();
    });
    document.querySelector("[data-delivery-edit-cancel]").addEventListener("click", closeProductionDeliveryEdit);
    editDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeProductionDeliveryEdit();
    });
    editDialog.addEventListener("click", (event) => {
      if (event.target === editDialog) closeProductionDeliveryEdit();
    });
    document.querySelector("#production-edit-release-history").addEventListener("click", (event) => {
      if (!productionEditId) return;
      void openReleaseHistory(productionEditId, event.currentTarget).catch((error) =>
        toast(error.message || "Could not load release history.", "error"));
    });
    salespersonFilter.addEventListener("change", renderDeliveryRows);
    document.querySelector("#production-filter-reset").addEventListener("click", () => {
      searchInput.value = "";
      salespersonFilter.value = "";
      productionGoodsFilter = DEFAULT_GOODS_FILTER;
      setActiveSort({ key: "delivery_schedule", direction: "asc" }, "delivery_schedule");
      renderDeliveryRows();
    });
  }
  document.querySelector("#delivery-item-add").addEventListener("click", () => {
    clearDeliveryItemConflictState();
    deliveryItemsState.lines.push({ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "", goods_status: "" });
    renderItemLineEditor();
    document.querySelector("#delivery-item-lines").lastElementChild?.querySelector("input")?.focus();
  });
  document.querySelector("#delivery-item-save").addEventListener("click", async () => {
    deliveryItemsState.lines.forEach((line) => {
      line.so_number = normalizeSoNumber(line.so_number);
    });
    document.querySelectorAll("#delivery-item-lines [name='so_number']").forEach((input, index) => {
      input.value = deliveryItemsState.lines[index]?.so_number || "";
      updateSoFormatHint(input, deliveryItemsState.lines[index] || {});
    });
    const lines = deliveryItemsMarkup(deliveryItemsState.lines);
    const productionStoreForm = isProductionStoreMode() && !deliveryEditId;
    const productionEntry = productionStoreForm && !productionEditId;
    clearDeliveryItemErrors();
    let firstInvalid = null;
    lines.forEach((line, index) => {
      const row = document.querySelectorAll("#delivery-item-lines .delivery-item-row")[index];
      const invalidFields = productionEditId
        ? []
        : productionStoreForm
        ? [
          ["item_name", !line.item_name.trim()],
          ["quantity", !/^[1-9]\d*$/.test(line.quantity)],
          ["goods_status", productionEntry && !line.goods_status]
        ]
        : [
          ["so_number", !hasSoNumber(line.so_number)],
          ["item_name", !line.item_name.trim()],
          ["quantity", !/^[1-9]\d*$/.test(line.quantity) || Number(line.quantity) > 99999],
          ["address", !line.address.trim()]
        ];
      invalidFields.forEach(([name, invalid]) => {
        if (!invalid) return;
        const input = row.querySelector(`[name="${name}"]`);
        input.classList.add("field-error");
        firstInvalid ||= input;
      });
    });
    if (firstInvalid) {
      document.querySelector("#delivery-items-message").textContent = "Please fill in the highlighted fields.";
      firstInvalid.focus();
      return;
    }
    if (!await checkDeliveryItemPairs(lines, null, null, true, true)) return;
    const serialized = JSON.stringify(lines);
    document.querySelector('[name="items"]').value = serialized;
    document.querySelector("#delivery-items-open").textContent = isProductionStoreMode()
      ? productionStoreItemSummary(lines, productionEditId)
      : lines.map((line) => `${line.item_name}${line.quantity ? ` × ${line.quantity} pcs` : ""}`).join(" · ");
    clearDeliveryItemErrors();
    if (productionEditId) {
      const itemsDialog = document.querySelector("#delivery-items-dialog");
      const editDialog = document.querySelector("#delivery-edit-dialog");
      editDialog.addEventListener("close", () => {
        if (itemsDialog.open) itemsDialog.close();
      }, { once: true });
      document.querySelector("#delivery-request-form").requestSubmit();
      return;
    }
    document.querySelector("#delivery-items-dialog").close();
    document.querySelector("#delivery-items-open").focus();
  });
  bindEditorKeyboard(document.querySelector("#delivery-items-dialog"));
  document.querySelector("#delivery-item-discard").addEventListener("click", () => closeDeliveryItems(true));
  document.querySelectorAll("[data-items-close]").forEach((button) => button.addEventListener("click", () => closeDeliveryItems(true)));
  document.querySelector("#delivery-items-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDeliveryItems(true);
  });
  document.querySelector("#delivery-items-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDeliveryItems(true);
  });
  bindSortableHeaders();
  const deliveryCards = hasProductionAccess(profile) || hasDispatchAccess(profile)
    ? [
      { label: "Received", dateColumn: "created_at" },
      { label: "Marked ready", dateColumn: "ready_at" },
      { label: "Pending", dateColumn: "created_at", filters: { dispatch_status: "Not delivered" } },
      { label: "Packed", dateColumn: "dispatched_at" },
      { label: "Delivered", dateColumn: "delivered_at" }
    ]
    : [
      { label: "Requested", dateColumn: "created_at" },
      { label: "Ready", dateColumn: "ready_at" },
      { label: "Packed", dateColumn: "dispatched_at" },
      { label: "Delivered", dateColumn: "delivered_at" }
    ];
  if (page === "deliveries.html") {
    const tiles = document.querySelector("#delivery-tallies");
    const openFromTile = (event) => {
      const tile = event.target.closest(".delivery-activity-tile");
      if (!tile || !tiles.contains(tile)) return;
      const card = deliveryCards[Number(tile.dataset.deliveryActivityIndex)];
      if (card) void openDeliveryActivity(card, deliveryActivityPeriod);
    };
    tiles.addEventListener("click", openFromTile);
    tiles.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.matches(".delivery-activity-tile")) {
        event.preventDefault();
        event.target.click();
      }
    });
    const dialog = document.querySelector("#delivery-activity-dialog");
    const deliveryBody = document.querySelector("#delivery-rows");
    const openDeliveryRow = (row) => {
      if (row.classList.contains("row-exit-right")) return;
      const trigger = row.querySelector("[data-delivery-view]");
      const delivery = deliveryRows.find((item) => item.id === row.dataset.entryId);
      if (delivery && trigger) void openDeliveryView(delivery, trigger);
    };
    deliveryBody.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest("tr[data-row-view]");
      if (!row || !deliveryBody.contains(row)
        || event.target.closest("button, select, a, input, label, textarea, [data-delivery-items]")
        || window.getSelection()?.toString()) return;
      openDeliveryRow(row);
    });
    deliveryBody.addEventListener("keydown", (event) => {
      if (!(event.target instanceof HTMLTableRowElement)
        || !event.target.matches("tr[data-row-view]")
        || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      openDeliveryRow(event.target);
    });
    document.querySelectorAll("[data-delivery-activity-close]").forEach((button) =>
      button.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    setupDeliveryPeriodPicker(() => {
      if (dialog.open) dialog.close();
      document.querySelector("#delivery-period").dispatchEvent(new Event("change", { bubbles: true }));
    });
    document.querySelector("#delivery-activity-print").addEventListener("click", () => window.print());
  }
  bindPeriodSummary("delivery-period", async () => {
    await renderPeriodSummary("delivery-tallies", "delivery-period", deliveryReadTable(), deliveryCards);
    if (page === "deliveries.html") {
      document.querySelectorAll("#delivery-tallies .stat-card").forEach((tile, index) => {
        tile.classList.add("delivery-activity-tile");
        tile.tabIndex = 0;
        tile.setAttribute("role", "button");
        tile.dataset.deliveryActivityIndex = String(index);
      });
    }
  });
  await loadDeliveries();
  await refreshAssignedPendingDeliveries();
  await refreshUrgentDeliveryAlerts();
  client.channel(`deliveries-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "deliveries"
  }, (event) => {
    if (document.hidden) return;
    const id = event.new?.id || event.old?.id;
    if (!id) return;
    deliveryRealtimeIds.add(id);
    if (deliveryRealtimeTimer !== null) window.clearTimeout(deliveryRealtimeTimer);
    deliveryRealtimeTimer = window.setTimeout(() => {
      const ids = [...deliveryRealtimeIds];
      deliveryRealtimeIds.clear();
      deliveryRealtimeTimer = null;
      void patchDeliveryRowsById(ids).catch((error) =>
        toast(error.message || "Could not apply delivery updates.", "error"));
    }, 250);
  }).subscribe();
  if (hasDispatchAccess(profile) || profile.role === "admin") {
    client.channel(`delivery-vehicles-${profile.id}`).on("postgres_changes", {
      event: "*", schema: "public", table: "vehicles"
    }, async () => {
      await loadActiveVehicles(true);
      renderDeliveryRows();
    }).subscribe();
  }
  startVisibleRefresh(async () => {
    await refreshDeliveryRows();
    if (hasDispatchAccess(profile) || profile.role === "admin") {
      await loadActiveVehicles();
      renderDeliveryRows();
    }
  }, {
    intervalMs: 5 * 60 * 1000,
    visibilityMinAgeMs: 60 * 1000,
    lastRefreshAt: () => deliveryLastFullRefreshAt
  });
}



export function getDeliveryActivityPeriod() {
  return deliveryActivityPeriod;
}
