import { client } from "./core/supabase-client.js";
import { bindLogoutHandlers, loadAuthContext, watchSignedOut } from "./core/auth.js";
import { invokeAdmin } from "./services/admin.service.js";
import { fetchProfiles } from "./services/users.service.js";
import { bindPasswordHints } from "./ui/password-hints.js";
import { bindEditorKeyboard } from "./ui/dialog-keyboard.js";
import { endSession, monitorSessionExpiry, sessionIsWithinLimit } from "./core/session.js";
import { startVisibleRefresh } from "./core/visible-refresh.js";
import { hasDispatchAccess, hasProductionAccess, hasProductionStoreAccess, initPortal } from "./portal.js";
import { currentNairobiTime, deliverySlotLabel, deliverySlotOptions, hourlySlots } from "./utils/delivery-slots.js";
import { initShortcuts } from "./ui/shortcuts.js";
import { configureScrollableTables, initializeScrollableTables, initializeScrollableTableRow } from "./ui/scrollable-table.js";
import { initVehicles } from "./pages/vehicles.js";
import { initRiders, initMyJobs, setRouteActivityRows } from "./features/rider-jobs.js";
import { renderStatusChipButtons } from "./ui/status-chips.js";
import { initUsers } from "./pages/users.js";
import { lineFieldMarkup, initLineDialog } from "./features/line-dialog.js";
import { brandingFieldMarkup, initBrandingDialog } from "./features/branding-dialog.js";
import { escapeHtml } from "./utils/escape-html.js";
import { debounce } from "./utils/debounce.js";
import { lineFieldNames, lineFieldTitles, linesFromValue } from "./utils/lines.js";
import { brandingModes, normalizeBrandingDetails } from "./utils/branding.js";
import { today, dateKey, localDate, localDateTime, periodBounds } from "./utils/dates.js";
import {
  configureActivityPanel, tallyMarkup, activityPeriodType, activityPeriodSummary, activityPeriodDetail,
  activityQuery, activityCount, activityRows,
  renderActivityReport, renderPeriodSummary, bindPeriodSummary
} from "./features/activity-panel.js";
import { toast } from "./ui/toast.js";
import { setBusy } from "./ui/busy.js";
import { initStatusBoard } from "./pages/status-board.js";
import { configureTableSort, setActiveSort, sortRows, updateSortIndicators, bindSortableHeaders } from "./ui/table-sort.js";
import {
  deliverySoNumbers, deliveryAddress, deliveryMissingAddress, deliveryAddressUrgent,
  deliveryGoodsStatusLabel, deliveryGoodsStatus, deliveryProductionStatusMarkup,
  deliveryDispatchStatusMarkup
} from "./utils/delivery-rows.js";

const historyDialog = document.querySelector("#history-dialog");
historyDialog?.querySelector("[data-close-dialog]")?.addEventListener("click", () => historyDialog.close());
const page = location.pathname.split("/").pop();
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
let allRows = [];
async function saveLines(recordId, field, lines) {
  const { data, error } = await client.from("artwork_requests").update({ [field]: lines })
    .eq("id", recordId).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This request can no longer be edited. Refresh the page and try again.");
}

async function saveBranding(recordId, details) {
  const { data, error } = await client.from("artwork_requests").update({ branding_details: details })
    .eq("id", recordId).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This request can no longer be edited. Refresh the page and try again.");
}

function onSaved(recordId, field, value) {
  const row = allRows.find((item) => item.id === recordId);
  if (row) row[field] = value;
}

initLineDialog({ saveLines, onSaved });
initBrandingDialog({ saveBranding, onSaved });
configureActivityPanel({
  getDeliveryPeriod: () => deliveryActivityPeriod,
  setRouteRows: setRouteActivityRows
});
configureTableSort({ page, rerender: rerenderSortedPage });

let allChanges = [];
let designerOpenArtworkIds = new Set();
let allWorkNotes = [];
let workNotesByRequest = new Map();
let activeWorkNoteRequestId = null;
let users = [];
let deliveryRows = [];
let deliveryRoleStatusFilter = "pending";
let deliveryUrgentFilter = false;

























let artworkRealtimeTimer = null;
let artworkRefreshInFlight = false;
let artworkRefreshQueued = false;
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
let sessionExpiryTimer = null;
let designerChangeTrigger = null;
let designerBodyOverflow = "";
let designerRenderToken = 0;
let donePopoverTrigger = null;

let assignmentNotifications = [];

function rerenderSortedPage() {
  if (page === "sales.html") renderSales();
  else if (page === "designer.html") void renderDesigner();
  else if (page === "admin.html") renderAdminRows();
  else if (page === "deliveries.html") renderDeliveryRows();
  else if (page === "production-store.html") renderDeliveryRows();
}

function statusBadge(status) {
  const className = status === "Done" || status === "Change done" ? "done" : status === "In progress" ? "progress" : status === "Change requested" ? "change" : "requested";
  return `<span class="badge ${className}">${escapeHtml(status)}</span>`;
}

function profileName(id) {
  return users.find((user) => user.id === id)?.full_name || users.find((user) => user.id === id)?.username || "Any";
}

function preferredDesignerName(row) {
  return row.preferred_designer_recorded === false ? "Not recorded" : profileName(row.preferred_designer);
}

async function loadUsers() {
  users = await fetchProfiles();
  return users;
}

async function loadArtworks() {
  const requestColumns = page === "sales.html"
    ? "id,sr,created_month,created_at,ref_no,created_by,category,client_name,reference_type,previous_reference,so_number,product,branding_details,high_res_logo,redesign_logo,additional_info,date_needed,preferred_designer,preferred_designer_recorded,status,completed_at,done_at"
    : page === "designer.html"
      ? "id,sr,ref_no,created_at,created_by,client_name,reference_type,previous_reference,so_number,date_needed,product,branding_details,category,additional_info,status,assigned_designer,preferred_designer,preferred_designer_recorded,done_at"
      : "id,ref_no,sr,created_at,created_month,created_by,preferred_designer,preferred_designer_recorded,assigned_designer,category,client_name,reference_type,previous_reference,so_number,product,branding_details,high_res_logo,redesign_logo,additional_info,date_needed,status,claimed_at,done_at,done_by,designer_notes,change_count,changes_done,updated_at";
  const { data, error } = await client.from("artwork_requests").select(requestColumns).order("sr", { ascending: true });
  if (error) throw error;
  allRows = data || [];
  const changeColumns = page === "sales.html"
    ? "artwork_id,requested_on,status,done_at"
    : page === "designer.html"
      ? "artwork_id,status,created_at,done_at,change_text,requested_by,requested_on"
      : null;
  if (changeColumns && allRows.length) {
    const changeResult = await client.from("artwork_changes").select(changeColumns).in("artwork_id", allRows.map((row) => row.id));
    if (changeResult.error) throw changeResult.error;
    allChanges = changeResult.data || [];
  } else {
    allChanges = [];
  }
  designerOpenArtworkIds = new Set(allChanges
    .filter((change) => change.status === "open")
    .map((change) => change.artwork_id));
  return allRows;
}

async function loadWorkNotes() {
  const requestIds = allRows.map((row) => row.id);
  if (!requestIds.length) {
    allWorkNotes = [];
    workNotesByRequest = new Map();
    return allWorkNotes;
  }
  const { data, error } = await client.from("artwork_work_notes")
    .select("id,request_id,author_id,author_name,author_role,message,created_at")
    .in("request_id", requestIds).order("created_at", { ascending: true });
  if (error) throw error;
  allWorkNotes = data || [];
  workNotesByRequest = new Map();
  allWorkNotes.forEach((note) => workNotesByRequest.set(note.request_id, [
    ...(workNotesByRequest.get(note.request_id) || []), note
  ]));
  return allWorkNotes;
}

function workNotesFor(requestId) {
  return workNotesByRequest.get(requestId) || [];
}

function workNotePreviewMarkup(requestId, salesperson = false) {
  const latest = workNotesFor(requestId).at(-1);
  const text = latest?.message || "";
  const preview = text.length > 30 ? `${text.slice(0, 30).trimEnd()}…` : text || (salesperson ? "No note yet" : "Add note");
  const unread = salesperson && latest?.author_role === "designer"
    ? '<span class="badge change" title="New designer note">New</span>' : "";
  const requestAttribute = salesperson ? "data-request-id" : "data-work-notes";
  return `<button type="button" class="quiet work-note-preview" ${requestAttribute}="${escapeHtml(requestId)}" title="${escapeHtml(text || (salesperson ? "No note yet" : "Add note"))}">${escapeHtml(preview)}${unread}</button>`;
}

function workNoteMessageMarkup(message) {
  const text = String(message ?? "");
  const matches = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)];
  let html = "";
  let cursor = 0;
  for (const match of matches) {
    html += escapeHtml(text.slice(cursor, match.index));
    let url = match[0];
    let suffix = "";
    while (/[.,!?;:)\]]$/.test(url)) {
      suffix = url.slice(-1) + suffix;
      url = url.slice(0, -1);
    }
    const safeUrl = escapeHtml(url);
    html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>${escapeHtml(suffix)}`;
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(cursor));
}

function workNoteThreadMarkup(requestId) {
  const notes = workNotesFor(requestId);
  return notes.length ? notes.map((note) => `<article class="change-item work-note-entry"${note.author_role === "salesperson" ? ' style="background:#f3f7ff;border-left-color:var(--blue)"' : ""}>
    <p class="work-note-message">${workNoteMessageMarkup(note.message)}</p>
    <small>${escapeHtml(note.author_name)} · ${note.author_role === "designer" ? "Designer" : "Salesperson"} · ${escapeHtml(localDateTime(note.created_at))}</small>
  </article>`).join("") : '<p class="empty-state">No work notes yet.</p>';
}

function openWorkNotes(requestId, authorRole) {
  const row = allRows.find((item) => item.id === requestId);
  if (!row) return toast("This artwork request is no longer available.", "error");
  activeWorkNoteRequestId = requestId;
  const prefix = authorRole === "designer" ? "designer" : "sales";
  const dialog = document.querySelector(`#${prefix}-work-notes-dialog`);
  const textarea = document.querySelector(`#${prefix}-work-notes-message`);
  const saveButton = document.querySelector(`#${prefix}-work-notes-save`);
  const canWrite = authorRole === "salesperson"
    || (row.assigned_designer === profile.id && row.status === "In progress");
  textarea.value = "";
  textarea.disabled = !canWrite;
  saveButton.disabled = true;
  document.querySelector(`#${prefix}-work-notes-thread`).innerHTML = workNoteThreadMarkup(requestId);
  if (authorRole === "designer") {
    document.querySelector("#designer-work-notes-locked").classList.toggle("hidden", canWrite);
  }
  dialog.showModal();
  if (canWrite) textarea.focus();
}

function bindWorkNotes(authorRole) {
  const prefix = authorRole === "designer" ? "designer" : "sales";
  const dialog = document.querySelector(`#${prefix}-work-notes-dialog`);
  const form = document.querySelector(`#${prefix}-work-notes-form`);
  const textarea = document.querySelector(`#${prefix}-work-notes-message`);
  const saveButton = document.querySelector(`#${prefix}-work-notes-save`);
  const updateSaveButton = () => {
    saveButton.disabled = textarea.disabled || !textarea.value.trim() || textarea.value.trim().length > 2000;
  };
  textarea.addEventListener("input", updateSaveButton);
  document.querySelector(`#${prefix}-work-notes-close`).addEventListener("click", () => dialog.close());
  document.querySelector(`#${prefix}-work-notes-discard`).addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    form.reset();
    textarea.disabled = false;
    saveButton.disabled = true;
    activeWorkNoteRequestId = null;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWorkNote(authorRole, textarea, saveButton, dialog);
  });
}

async function saveWorkNote(authorRole, textarea, saveButton, dialog) {
  const message = textarea.value.trim();
  if (!activeWorkNoteRequestId || !message || message.length > 2000) return updateWorkNoteSaveButton(textarea, saveButton);
  const requestId = activeWorkNoteRequestId;
  saveButton.disabled = true;
  try {
    const { data, error } = await client.from("artwork_work_notes").insert({
      request_id: requestId,
      author_id: profile.id,
      author_name: profile.full_name,
      author_role: authorRole,
      message
    }).select("id,request_id,author_id,author_name,author_role,message,created_at").single();
    if (error) throw error;
    allWorkNotes.push(data);
    workNotesByRequest.set(requestId, [...workNotesFor(requestId), data]);
    dialog.close();
    if (page === "sales.html") renderSales();
    else void renderDesigner();
    toast("Work note saved.");
  } catch (error) {
    toast(error.message || "Could not save the work note.", "error");
    updateWorkNoteSaveButton(textarea, saveButton);
  }
}

function updateWorkNoteSaveButton(textarea, saveButton) {
  saveButton.disabled = textarea.disabled || !textarea.value.trim() || textarea.value.trim().length > 2000;
}

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

async function initSales() {
  document.querySelector("#current-user").textContent = profile.full_name;
  const [rows, loadedUsers] = await Promise.all([loadArtworks(), loadUsers()]);
  await loadWorkNotes();
  bindSortableHeaders();
  renderSalesTallies();
  renderSales();
  document.querySelector("#sales-period").addEventListener("change", renderSalesTallies);
  document.querySelector("#sales-search").addEventListener("input", debounce(renderSales));
  document.querySelector("#sales-status").addEventListener("change", renderSales);
  document.querySelector("#new-request").addEventListener("click", () => openRequestEditor());
  document.querySelector("#change-form").addEventListener("submit", saveChange);
  bindWorkNotes("salesperson");
  document.querySelector("#sales-rows").addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest("[data-request-id]");
    if (trigger) openWorkNotes(trigger.dataset.requestId, "salesperson");
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("click", (event) => {
    if (donePopoverTrigger && !event.target.closest("#done-time-popover, .done-time-trigger")) closeDonePopover();
  });
  subscribeToChanges();
  startVisibleRefresh(refreshArtworks, { intervalMs: 3 * 60 * 1000 });
  void loadedUsers;
}

function renderSalesTallies() {
  const inPeriod = periodBounds(document.querySelector("#sales-period").value);
  const ownRows = allRows.filter((row) => row.created_by === profile.id);
  const ownIds = new Set(ownRows.map((row) => row.id));
  const rows = ownRows.filter((row) => inPeriod(row.created_at));
  const changes = allChanges.filter((change) => ownIds.has(change.artwork_id) && inPeriod(change.requested_on));
  document.querySelector("#sales-tallies").innerHTML = tallyMarkup([
    ["Artworks requested", rows.length],
    ["Artworks done", ownRows.filter((row) => row.status === "Done" && inPeriod(row.done_at)).length],
    ["Changes requested", changes.length],
    ["Changes done", changes.filter((change) => change.status === "done" && inPeriod(change.done_at)).length]
  ]);
}

function renderSales() {
  closeDonePopover();
  const search = document.querySelector("#sales-search").value.trim().toLowerCase();
  const status = document.querySelector("#sales-status").value;
  const rows = sortRows(allRows.filter((row) => row.created_by === profile.id
    && (!status || row.status === status)
    && (!search || `${row.ref_no} ${row.client_name} ${artworkReferenceSearchValue(row)}`.toLowerCase().includes(search))));
  const tbody = document.querySelector("#sales-rows");
  tbody.innerHTML = rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}">
    <td>${escapeHtml(row.sr)}</td><td>${escapeHtml(row.created_month)}</td><td>${localDate(row.created_at)}</td>
    <td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(profile.full_name)}</td><td>${escapeHtml(row.client_name)}</td><td>${escapeHtml(artworkReferenceLabel(row))}</td>
    <td>${lineFieldMarkup("product", row.product, { mode: row.status === "Requested" ? "edit" : "view", recordId: row.id, direct: row.status === "Requested" })}</td>
    <td>${brandingFieldMarkup(row.branding_details, { mode: row.status === "Requested" ? "edit" : "view", recordId: row.id, direct: row.status === "Requested" })}</td>
    <td>${localDate(row.date_needed)}</td><td>${escapeHtml(preferredDesignerName(row))}</td><td>${workNotePreviewMarkup(row.id, true)}</td>
    <td>${row.status === "Done" ? `<button type="button" class="badge done done-time-trigger" data-done-time="${escapeHtml(row.completed_at || "")}" aria-expanded="false" aria-label="Done status, show completion time">Done</button> <span title="Designer marked this done">✓</span>` : statusBadge(row.status)}</td>
    <td>${row.status === "Done" && row.completed_at ? escapeHtml(localDateTime(row.completed_at)) : "—"}</td>
    <td><div class="table-actions">
      <button class="secondary" data-history="${escapeHtml(row.id)}">History</button>
      <button class="secondary" data-change="${escapeHtml(row.id)}">Change</button>
      <button class="quiet" data-edit="${escapeHtml(row.id)}" ${row.status !== "Requested" ? "disabled" : ""}>Edit</button>
    </div></td></tr>`).join("");
  initializeScrollableTables(tbody.closest("table"));
  document.querySelector("#sales-empty").classList.toggle("hidden", rows.length > 0);
  updateSortIndicators();
  tbody.querySelectorAll("[data-done-time]").forEach((button) => button.addEventListener("click", () => {
    openDonePopover(button, button.dataset.doneTime);
  }));
  tbody.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => openRequestEditor(allRows.find((row) => row.id === button.dataset.edit))));
  tbody.querySelectorAll("[data-change]").forEach((button) => button.addEventListener("click", () => openChangeDialog(allRows.find((row) => row.id === button.dataset.change))));
  tbody.querySelectorAll("[data-history]").forEach((button) => button.addEventListener("click", () => showHistory(button.dataset.history)));
}

function closeDonePopover() {
  document.querySelector("#done-time-popover")?.remove();
  donePopoverTrigger?.setAttribute("aria-expanded", "false");
  donePopoverTrigger = null;
}

function openDonePopover(trigger, timestamp) {
  if (donePopoverTrigger === trigger) {
    closeDonePopover();
    return;
  }
  closeDonePopover();
  const date = timestamp
    ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Nairobi" }).format(new Date(timestamp))
    : "—";
  const time = timestamp
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" }).format(new Date(timestamp))
    : "—";
  const popover = document.createElement("div");
  popover.id = "done-time-popover";
  popover.className = "done-time-popover";
  popover.setAttribute("role", "tooltip");
  popover.textContent = `Done on ${date} at ${time}`;
  document.body.append(popover);
  const bounds = trigger.getBoundingClientRect();
  const left = Math.min(Math.max(8, bounds.left), window.innerWidth - 248);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.min(bounds.bottom + 8, window.innerHeight - 56)}px`;
  trigger.setAttribute("aria-expanded", "true");
  donePopoverTrigger = trigger;
}

const SO_NUMBER_PREFIX = "SO-";
const SO_REFERENCE_PLACEHOLDER = "SO-N/A";

function artworkReferenceLabel(row) {
  if (row.reference_type === "new") return "New artwork";
  if (row.reference_type === "old") return `Old artwork${row.previous_reference ? ` · ${row.previous_reference}` : ""}`;
  return String(row.so_number ?? "");
}

function artworkReferenceSearchValue(row) {
  if (row.reference_type === "old") return row.previous_reference || "";
  if (row.reference_type == null) return row.so_number || "";
  return artworkReferenceLabel(row);
}

function updatePreviousReferenceField(form) {
  const field = form.elements.previous_reference;
  const wrapper = field?.closest("[data-previous-reference-field]");
  if (!field || !wrapper) return;
  const required = form.elements.reference_type.value === "old";
  wrapper.hidden = !required;
  field.disabled = !required;
  field.required = required;
}

function bindReferenceType(form) {
  const referenceType = form.elements.reference_type;
  if (!referenceType || referenceType.disabled) return;
  referenceType.addEventListener("change", () => updatePreviousReferenceField(form));
  updatePreviousReferenceField(form);
}

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

function requestFormMarkup(row = null) {
  const editing = Boolean(row);
  const legacy = editing && row.reference_type == null;
  const activeDesigners = users.filter((user) => user.role === "designer" && user.active);
  const inactivePreferred = row?.preferred_designer && !activeDesigners.some((user) => user.id === row.preferred_designer)
    ? users.find((user) => user.id === row.preferred_designer) : null;
  const designers = (inactivePreferred
    ? `<option value="${escapeHtml(inactivePreferred.id)}" selected>${escapeHtml(inactivePreferred.full_name)} (inactive)</option>` : "")
    + activeDesigners.map((user) => `<option value="${escapeHtml(user.id)}" ${row?.preferred_designer === user.id ? "selected" : ""}>${escapeHtml(user.full_name)}</option>`).join("");
  const referenceFields = legacy
    ? `<label>Reference<input value="${escapeHtml(artworkReferenceLabel(row))}" readonly></label>`
    : `<label>Reference type<select name="reference_type" required><option value="">Select…</option><option value="new"${row?.reference_type === "new" ? " selected" : ""}>New artwork</option><option value="old"${row?.reference_type === "old" ? " selected" : ""}>Old artwork</option></select></label>
      <label data-previous-reference-field${row?.reference_type === "old" ? "" : " hidden"}>Previous artwork reference no<input name="previous_reference" value="${escapeHtml(row?.previous_reference || "")}"${row?.reference_type === "old" ? " required" : " disabled"}></label>`;
  return `<form id="request-form" class="request-form"><div class="form-grid">
    <label>Category<select name="category" required><option value="">Select…</option><option ${row?.category === "New client" ? "selected" : ""}>New client</option><option ${row?.category === "Old client" ? "selected" : ""}>Old client</option></select></label>
    <label>Client name<input name="client_name" value="${escapeHtml(row?.client_name)}" required></label>
    ${referenceFields}
    ${editing ? "" : `<input type="hidden" name="so_number" value="${SO_REFERENCE_PLACEHOLDER}">`}
    <div class="line-field-label"><span>Product with code and colour</span>${lineFieldMarkup("product", row?.product)}</div>
    <div class="line-field-label"><span>Branding</span>${brandingFieldMarkup(row?.branding_details)}</div>
    <label class="check-line"><input name="high_res_logo" type="checkbox" ${row?.high_res_logo ? "checked" : ""}> High resolution logo</label>
    <label class="check-line"><input name="redesign_logo" type="checkbox" ${row?.redesign_logo ? "checked" : ""}> Redesign logo</label>
    <label class="wide">Additional information<textarea name="additional_info" rows="2">${escapeHtml(row?.additional_info)}</textarea></label>
    <label>Date needed<input name="date_needed" type="date" min="${today}" value="${escapeHtml(row?.date_needed || "")}" required></label>
    <label>Designer preferred<select name="preferred_designer"><option value="">Any</option>${designers}</select></label>
  </div><div class="form-actions"><button type="button" class="quiet" id="discard-request">Discard</button><button class="primary" type="submit">${editing ? "Save changes" : "Save request"}</button></div></form>`;
}

function openRequestEditor(row = null) {
  const container = document.querySelector("#request-editor");
  container.innerHTML = requestFormMarkup(row);
  const form = container.querySelector("#request-form");
  bindReferenceType(form);
  form.addEventListener("submit", (event) => saveRequest(event, row));
  container.querySelector("#discard-request").addEventListener("click", () => {
    container.replaceChildren();
    toast("Draft discarded.");
  });
  container.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveRequest(event, existing) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setBusy(button, true);
  try {
    const data = new FormData(form);
    const isLegacy = existing && existing.reference_type == null;
    const referenceType = isLegacy ? null : data.get("reference_type");
    const previousReference = String(data.get("previous_reference") || "").trim();
    if (!isLegacy && !["new", "old"].includes(referenceType)) throw new Error("Choose New artwork or Old artwork.");
    if (!isLegacy && referenceType === "old" && !previousReference) throw new Error("Enter the previous artwork reference number.");
    const values = Object.fromEntries(["category","client_name","additional_info","date_needed"].map((name) => [name, data.get(name) || null]));
    if (!isLegacy) {
      values.reference_type = referenceType;
      values.previous_reference = referenceType === "old" ? previousReference : null;
    }
    if (!existing) values.so_number = data.get("so_number");
    for (const name of lineFieldNames) {
      const lines = linesFromValue(JSON.parse(data.get(name) || "[]"));
      if (!lines.length) throw new Error(`${lineFieldTitles[name]} must contain at least one non-empty line.`);
      values[name] = lines;
    }
    const brandingDetails = normalizeBrandingDetails(data.get("branding_details"))
      .map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, String(value).trim()])));
    if (!brandingDetails.length || brandingDetails.some((line) => !line.mode
      || Object.values(line).some((value) => value.length > 200))) {
      throw new Error("Add at least one branding line, choose a mode for each line, and keep each field to 200 characters or fewer.");
    }
    values.branding_details = brandingDetails;
    values.preferred_designer = data.get("preferred_designer") || null;
    values.preferred_designer_recorded = true;
    values.assigned_designer = values.preferred_designer;
    Object.assign(values, { high_res_logo: data.has("high_res_logo"), redesign_logo: data.has("redesign_logo") });
    if (values.date_needed < today) throw new Error("Date needed cannot be in the past.");
    let result;
    if (existing) {
      result = await client.from("artwork_requests").update(values).eq("id", existing.id).select("id").single();
    } else {
      result = await client.from("artwork_requests").insert({ ...values, created_by: profile.id }).select("id,ref_no").single();
    }
    if (result.error) throw result.error;
    toast(existing ? "Artwork request updated." : `Request saved as ${result.data.ref_no}.`);
    form.closest("#request-editor").replaceChildren();
    await refreshArtworks();
  } catch (error) {
    toast(error.message || "Could not save request.", "error");
  } finally {
    setBusy(button, false);
  }
}

function openChangeDialog(row) {
  const dialog = document.querySelector("#change-dialog");
  const form = document.querySelector("#change-form");
  form.reset();
  form.elements.artwork_id.value = row.id;
  form.elements.requested_by.value = profile.full_name;
  form.elements.requested_on.value = today;
  dialog.showModal();
}

async function saveChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    const { error } = await client.from("artwork_changes").insert({
      artwork_id: values.artwork_id, change_text: values.change_text,
      requested_by: values.requested_by, requested_on: values.requested_on
    });
    if (error) throw error;
    form.closest("dialog").close();
    toast("Change request sent to the designer.");
    await refreshArtworks();
  } catch (error) {
    toast(error.message || "Could not submit change request.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function showHistory(artworkId) {
  const { data, error } = await client.from("artwork_changes")
    .select("change_text,requested_by,requested_on,status,done_by,done_at")
    .eq("artwork_id", artworkId).order("requested_on");
  if (error) return toast(error.message, "error");
  const content = document.querySelector("#history-content");
  content.innerHTML = data.length ? data.map((change) => `<div class="change-item">${escapeHtml(change.change_text)}<small>${escapeHtml(change.requested_by)} · Requested ${localDate(change.requested_on)} · ${change.status === "done" ? `Done by ${escapeHtml(profileName(change.done_by))} ${localDateTime(change.done_at)}` : "Open"}</small></div>`).join("") : '<p class="empty-state">No changes requested.</p>';
  document.querySelector("#history-dialog").showModal();
}

async function initDesigner() {
  document.querySelector("#current-user").textContent = profile.full_name;
  await Promise.all([loadUsers(), loadArtworks(), loadAssignmentNotifications()]);
  await loadWorkNotes();
  bindSortableHeaders();
  renderDesignerTallies();
  document.querySelector("#designer-period").addEventListener("change", () => { void renderDesignerTallies(); });
  renderDesigner();
  bindWorkNotes("designer");
  document.querySelector("#designer-filter").addEventListener("change", renderDesigner);
  const designerSearch = document.querySelector("#designer-search");
  const designerSearchClear = document.querySelector("#designer-search-clear");
  const searchDesigner = debounce(renderDesigner, 150);
  designerSearch.addEventListener("input", () => {
    designerSearchClear.classList.toggle("hidden", !designerSearch.value);
    searchDesigner();
  });
  designerSearchClear.addEventListener("click", () => {
    designerSearch.value = "";
    designerSearchClear.classList.add("hidden");
    renderDesigner();
    designerSearch.focus();
  });
  const designerRows = document.querySelector("#designer-rows");
  designerRows.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const noteTrigger = event.target.closest("[data-work-notes]");
    if (noteTrigger) {
      openWorkNotes(noteTrigger.dataset.workNotes, "designer");
      return;
    }
    const trigger = event.target.closest("[data-change-request]");
    if (trigger) openDesignerChangeDialog(trigger, trigger.textContent);
  });
  const changeDialog = document.querySelector("#designer-change-dialog");
  document.querySelector("#designer-change-close").addEventListener("click", () => changeDialog.close());
  changeDialog.addEventListener("click", (event) => {
    if (event.target === changeDialog) changeDialog.close();
  });
  changeDialog.addEventListener("close", () => {
    document.body.style.overflow = designerBodyOverflow;
    if (designerChangeTrigger?.isConnected) designerChangeTrigger.focus();
    designerChangeTrigger = null;
  });
  document.querySelector("#change-bell").addEventListener("click", () => {
    document.querySelector("#designer-filter").value = "changes";
    renderDesigner();
  });
  document.querySelector("#assignment-bell").addEventListener("click", () => {
    document.querySelector("#designer-filter").value = "assignments";
    renderDesigner();
  });
  subscribeToChanges();
  startVisibleRefresh(refreshArtworks, { intervalMs: 3 * 60 * 1000 });
}

function openDesignerChangeDialog(trigger, text) {
  const dialog = document.querySelector("#designer-change-dialog");
  designerChangeTrigger = trigger;
  designerBodyOverflow = document.body.style.overflow;
  document.querySelector("#designer-change-text").textContent = text;
  document.body.style.overflow = "hidden";
  dialog.showModal();
  document.querySelector("#designer-change-text").focus();
}

function visibleDesignerRows() {
  return allRows;
}

async function loadAssignmentNotifications() {
  const { data, error } = await client.from("designer_notifications")
    .select("id,artwork_id,created_at")
    .is("read_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  assignmentNotifications = data || [];
  return assignmentNotifications;
}

async function renderDesignerTallies() {
  try {
    const rows = visibleDesignerRows();
    const inPeriod = periodBounds(document.querySelector("#designer-period").value);
    const received = rows.filter((row) => inPeriod(row.created_at));
    const changesInPeriod = allChanges;
    document.querySelector("#designer-tallies").innerHTML = tallyMarkup([
      ["Requests received", received.length],
      ["Artworks done", rows.filter((row) => row.status === "Done" && inPeriod(row.done_at)).length],
      ["Artworks pending", received.filter((row) => row.status !== "Done").length],
      ["Changes requested", changesInPeriod.filter((change) => inPeriod(change.created_at)).length],
      ["Changes done", changesInPeriod.filter((change) => change.status === "done" && inPeriod(change.done_at)).length]
    ]);
    document.querySelector("#change-count").textContent = designerOpenArtworkIds.size;
    document.querySelector("#assignment-count").textContent = assignmentNotifications.length;
  } catch (error) {
    toast(error.message, "error");
  }
}

function tomorrow() {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function renderDesigner() {
  const renderToken = ++designerRenderToken;
  try {
    const rows = visibleDesignerRows();
    const openArtworkIds = designerOpenArtworkIds;
    if (renderToken !== designerRenderToken) return;
    const assignedIds = new Set(assignmentNotifications.map((notice) => notice.artwork_id));
    const allChangesByArtwork = new Map();
    allChanges.forEach((change) => allChangesByArtwork.set(change.artwork_id, [...(allChangesByArtwork.get(change.artwork_id) || []), change]));
    const filter = document.querySelector("#designer-filter").value;
    const searchTerm = document.querySelector("#designer-search").value.replace(/\s+/g, " ").trim().toLowerCase();
    const filtered = sortRows(rows.filter((row) => {
      const matchesSearch = !searchTerm || [row.ref_no, row.client_name].some((value) =>
        String(value || "").replace(/\s+/g, " ").toLowerCase().includes(searchTerm));
      if (!matchesSearch) return false;
      if (filter === "today") return row.date_needed === today;
      if (filter === "tomorrow") return row.date_needed === tomorrow();
      if (filter === "pending") return row.status !== "Done";
      if (filter === "done") return row.status === "Done";
      if (filter === "changes") return openArtworkIds.has(row.id);
      if (filter === "changes-done") {
        const changes = allChangesByArtwork.get(row.id) || [];
        return changes.length > 0 && changes.every((change) => change.status === "done");
      }
      if (filter === "assignments") return assignedIds.has(row.id)
        && (row.assigned_designer === profile.id || row.assigned_designer === null);
      return true;
    }));
    const tbody = document.querySelector("#designer-rows");
    tbody.innerHTML = filtered.map((row) => {
      const changes = allChangesByArtwork.get(row.id) || [];
      const pendingChanges = changes.filter((change) => change.status !== "done");
      const changeReadOnly = row.assigned_designer !== null && row.assigned_designer !== profile.id;
      const otherDetails = [row.category, row.additional_info].filter(Boolean).map(escapeHtml).join(" · ");
      const claimed = row.assigned_designer === profile.id && row.status === "In progress";
      const canStart = row.status !== "Done" && row.status !== "In progress"
        && (row.assigned_designer === null || row.assigned_designer === profile.id);
      return `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.ref_no)}</strong><br>${escapeHtml(row.client_name)}</td>
        <td>${escapeHtml(artworkReferenceLabel(row))}</td><td>${localDate(row.date_needed)}</td><td>${escapeHtml(profileName(row.created_by))}</td>
        <td><div class="designer-line-fields">${lineFieldMarkup("product", row.product, { mode: "view" })}${brandingFieldMarkup(row.branding_details, { mode: "view" })}</div>
        <p>${otherDetails}</p></td>
        <td>${statusBadge(row.status)}</td>
        <td>${changes.length === 0 ? "—" : pendingChanges.length === 0
          ? statusBadge("Change done")
          : statusBadge("Change requested")}${changes.length && changeReadOnly ? `<small>Read-only · Assigned to ${escapeHtml(profileName(row.assigned_designer))}</small>` : ""}${pendingChanges.filter((change) => change.change_text?.trim()).map((change) => `<div class="change-item"><button type="button" class="designer-change-request" data-change-request title="Click to view" aria-haspopup="dialog">${escapeHtml(change.change_text)}</button><small>${escapeHtml(change.requested_by)} · ${localDate(change.requested_on)}</small></div>`).join("")}</td>
        <td>${workNotePreviewMarkup(row.id)}</td>
        <td>${escapeHtml(preferredDesignerName(row))}${assignedIds.has(row.id) ? '<br><span class="badge assignment-badge">New assignment</span>' : ""}</td>
        <td><div class="table-actions">${canStart ? `<button class="primary" data-start="${escapeHtml(row.id)}">Start</button>` : ""}
        ${claimed && row.status !== "Done" ? `<button class="secondary" data-done="${escapeHtml(row.id)}">Done</button>` : ""}
        <button class="secondary" data-history="${escapeHtml(row.id)}">History</button></div></td></tr>`;
    }).join("");
    initializeScrollableTables(tbody.closest("table"));
    const emptyState = document.querySelector("#designer-empty");
    emptyState.textContent = "No jobs match this filter";
    emptyState.classList.toggle("hidden", filtered.length > 0);
    updateSortIndicators();
    document.querySelector("#change-banner").classList.toggle("hidden", openArtworkIds.size === 0);
    document.querySelector("#change-banner").textContent = openArtworkIds.size ? `CHANGE REQUESTED · ${openArtworkIds.size} artwork${openArtworkIds.size === 1 ? "" : "s"} need attention` : "";
    const assignmentBanner = document.querySelector("#assignment-banner");
    assignmentBanner.classList.toggle("hidden", assignmentNotifications.length === 0);
    assignmentBanner.textContent = assignmentNotifications.length
      ? `NEW ASSIGNMENT · ${assignmentNotifications.length} request${assignmentNotifications.length === 1 ? "" : "s"} assigned specifically to you.`
      : "";
    tbody.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", () => updateArtwork(button.dataset.start, { status: "In progress", assigned_designer: profile.id }, button, "Job started.")));
    tbody.querySelectorAll("[data-done]").forEach((button) => button.addEventListener("click", () => updateArtwork(button.dataset.done, { status: "Done", done_at: new Date().toISOString(), done_by: profile.id }, button, "Artwork marked done.")));
    tbody.querySelectorAll("[data-history]").forEach((button) => button.addEventListener("click", () => showHistory(button.dataset.history)));
  } catch (error) {
    toast(error.message || "Could not load the designer queue.", "error");
  }
}

async function updateArtwork(id, values, button, success) {
  setBusy(button, true);
  try {
    const { data, error } = await client.from("artwork_requests").update(values).eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This artwork is no longer available to update. Refresh the queue and try again.");
    toast(success);
    await refreshArtworks();
  } catch (error) {
    toast(error.message || "Could not update artwork.", "error");
  } finally {
    setBusy(button, false);
  }
}

function subscribeToChanges() {
  const channel = client.channel(`artwork-${profile.id}`).on("postgres_changes", { event: "*", schema: "public", table: "artwork_requests" }, () => {
    scheduleArtworkRealtimeRefresh();
  }).on("postgres_changes", { event: "*", schema: "public", table: "artwork_changes" }, () => {
    scheduleArtworkRealtimeRefresh();
  }).on("postgres_changes", { event: "*", schema: "public", table: "artwork_work_notes" }, () => {
    scheduleArtworkRealtimeRefresh();
  });
  if (page === "designer.html") {
    channel.on("postgres_changes", { event: "*", schema: "public", table: "designer_notifications" }, () => {
      scheduleArtworkRealtimeRefresh();
    });
  }
  channel.subscribe();
}

function scheduleArtworkRealtimeRefresh() {
  window.clearTimeout(artworkRealtimeTimer);
  artworkRealtimeTimer = window.setTimeout(() => {
    artworkRealtimeTimer = null;
    void refreshArtworks();
  }, 1200);
}

async function refreshArtworks() {
  window.clearTimeout(artworkRealtimeTimer);
  artworkRealtimeTimer = null;
  if (artworkRefreshInFlight) {
    artworkRefreshQueued = true;
    return;
  }
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) {
    if (openDialog.dataset.refreshPending !== "true") {
      openDialog.dataset.refreshPending = "true";
      openDialog.addEventListener("close", () => {
        delete openDialog.dataset.refreshPending;
        void refreshArtworks();
      }, { once: true });
    }
    return;
  }
  artworkRefreshInFlight = true;
  const previousIds = new Set(allRows.map((row) => row.id));
  const wasLoaded = allRows.length > 0;
  try {
    await Promise.all([
      loadArtworks(),
      page === "designer.html" ? loadAssignmentNotifications() : Promise.resolve()
    ]);
    if (page === "designer.html" || page === "sales.html") await loadWorkNotes();
    if (page === "sales.html") {
      renderSalesTallies();
      renderSales();
    } else if (page === "designer.html") {
      renderDesignerTallies();
      renderDesigner();
    } else if (page === "admin.html") {
      renderAdminTallies();
      renderAdminRows();
    }
    if (wasLoaded) {
      document.querySelectorAll("tbody tr[data-entry-id]").forEach((row) => {
        if (!previousIds.has(row.dataset.entryId)) row.classList.add("portal-new-row");
      });
    }
  } finally {
    artworkRefreshInFlight = false;
    if (artworkRefreshQueued) {
      artworkRefreshQueued = false;
      void refreshArtworks();
    }
  }
}

async function initAdmin() {
  document.querySelector("#current-user").textContent = profile.full_name;
  await Promise.all([loadUsers(), loadArtworks()]);
  bindSortableHeaders();
  renderAdmin();
  document.querySelector("#admin-period").addEventListener("change", renderAdminTallies);
  ["filter-sales", "filter-designer", "filter-status", "filter-category", "filter-from", "filter-to"].forEach((id) =>
    document.querySelector(`#${id}`).addEventListener("input", renderAdminRows));
  document.querySelector("#admin-search").addEventListener("input", debounce(renderAdminRows));
  document.querySelector("#export-csv").addEventListener("click", exportCsv);
  document.querySelector("#admin-edit-form").addEventListener("submit", saveAdminEdit);
  const adminEditForm = document.querySelector("#admin-edit-form");
  bindReferenceType(adminEditForm);
  adminEditForm.elements.preferred_designer.addEventListener("change", (event) => {
    if (event.currentTarget.value !== "__unknown") {
      document.querySelector("#admin-edit-form").elements.assigned_designer.value = event.currentTarget.value;
    }
  });
  document.querySelector("#admin-delete").addEventListener("click", deleteArtwork);
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  client.channel(`admin-artwork-${profile.id}`).on("postgres_changes", { event: "*", schema: "public", table: "artwork_requests" }, scheduleArtworkRealtimeRefresh).subscribe();
  startVisibleRefresh(refreshArtworks, { intervalMs: 3 * 60 * 1000 });
}

function renderAdmin() {
  renderAdminTallies();
  const salesSelect = document.querySelector("#filter-sales");
  const designerSelect = document.querySelector("#filter-designer");
  salesSelect.innerHTML = '<option value="">All salespeople</option>' + users.filter((user) => user.role === "salesperson").map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`).join("");
  designerSelect.innerHTML = '<option value="">All designers</option>' + users.filter((user) => user.role === "designer").map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`).join("");
  renderAdminRows();
}

function renderAdminTallies() {
  const inPeriod = periodBounds(document.querySelector("#admin-period").value);
  const rows = allRows.filter((row) => inPeriod(row.created_at));
  document.querySelector("#admin-tallies").innerHTML = tallyMarkup([
    ["Requested", rows.length], ["Done", rows.filter((row) => row.status === "Done").length],
    ["Pending", rows.filter((row) => row.status !== "Done").length],
    ["Changes", rows.reduce((total, row) => total + (row.change_count || 0), 0)]
  ]);
}

function filteredAdminRows() {
  const search = document.querySelector("#admin-search").value.trim().toLowerCase();
  const from = document.querySelector("#filter-from").value;
  const to = document.querySelector("#filter-to").value;
  return allRows.filter((row) => (!document.querySelector("#filter-sales").value || row.created_by === document.querySelector("#filter-sales").value)
    && (!document.querySelector("#filter-designer").value || row.preferred_designer === document.querySelector("#filter-designer").value)
    && (!document.querySelector("#filter-status").value || row.status === document.querySelector("#filter-status").value)
    && (!document.querySelector("#filter-category").value || row.category === document.querySelector("#filter-category").value)
    && (!from || dateKey(row.created_at) >= from) && (!to || dateKey(row.created_at) <= to)
    && (!search || `${row.ref_no} ${row.client_name} ${artworkReferenceSearchValue(row)}`.toLowerCase().includes(search)));
}

function renderAdminRows() {
  const tbody = document.querySelector("#admin-rows");
  if (!tbody) return;
  const rows = sortRows(filteredAdminRows());
  tbody.innerHTML = rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(row.client_name)}</td><td>${escapeHtml(artworkReferenceLabel(row))}</td>
    <td>${escapeHtml(profileName(row.created_by))}</td><td>${escapeHtml(preferredDesignerName(row))}</td><td>${escapeHtml(row.category)}</td>
    <td>${lineFieldMarkup("product", row.product, { recordId: row.id, direct: true })}</td>
    <td>${brandingFieldMarkup(row.branding_details, { recordId: row.id, direct: true })}</td>
    <td>${localDate(row.created_at)}</td><td>${localDate(row.date_needed)}</td><td>${statusBadge(row.status)}</td><td><button class="secondary" data-admin-edit="${escapeHtml(row.id)}">Edit</button></td></tr>`).join("");
  initializeScrollableTables(tbody.closest("table"));
  document.querySelector("#admin-empty").classList.toggle("hidden", rows.length > 0);
  updateSortIndicators();
  tbody.querySelectorAll("[data-admin-edit]").forEach((button) => button.addEventListener("click", () => openAdminEdit(allRows.find((row) => row.id === button.dataset.adminEdit))));
}

function openAdminEdit(row) {
  const form = document.querySelector("#admin-edit-form");
  form.reset();
  Object.entries(row).forEach(([key, value]) => {
    if (lineFieldNames.includes(key)) return;
    if (!form.elements[key]) return;
    if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
    else form.elements[key].value = value ?? "";
  });
  form.elements.display_reference.value = artworkReferenceLabel(row);
  form.elements.reference_type.value = row.reference_type || "";
  form.elements.reference_type.disabled = row.reference_type == null;
  form.elements.previous_reference.value = row.previous_reference || "";
  updatePreviousReferenceField(form);
  for (const name of lineFieldNames) {
    const slot = form.querySelector(`[data-line-slot="${name}"]`);
    slot.innerHTML = lineFieldMarkup(name, row[name]);
  }
  form.querySelector('[data-branding-slot="branding_details"]').innerHTML = brandingFieldMarkup(row.branding_details);
  const activeDesigners = users.filter((user) => user.role === "designer" && user.active);
  const preferredSelect = form.elements.preferred_designer;
  preferredSelect.innerHTML = '<option value="">Any</option>'
    + (row.preferred_designer_recorded === false ? '<option value="__unknown">Not recorded (historical)</option>' : "")
    + activeDesigners.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`).join("");
  if (row.preferred_designer && !activeDesigners.some((user) => user.id === row.preferred_designer)) {
    const previousPreference = users.find((user) => user.id === row.preferred_designer);
    preferredSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(row.preferred_designer)}">${escapeHtml(previousPreference?.full_name || "Inactive designer")} (inactive)</option>`);
  }
  preferredSelect.value = row.preferred_designer_recorded === false ? "__unknown" : row.preferred_designer || "";
  const assignedSelect = form.elements.assigned_designer;
  assignedSelect.innerHTML = '<option value="">Any / unassigned</option>'
    + activeDesigners.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`).join("");
  if (row.assigned_designer && !activeDesigners.some((user) => user.id === row.assigned_designer)) {
    const previousDesigner = users.find((user) => user.id === row.assigned_designer);
    assignedSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(row.assigned_designer)}">${escapeHtml(previousDesigner?.full_name || "Inactive designer")}</option>`);
  }
  assignedSelect.value = row.assigned_designer || "";
  document.querySelector("#admin-edit-dialog").showModal();
}

async function saveAdminEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  setBusy(button, true);
  try {
    const data = new FormData(form);
    const lineValues = {};
    for (const name of lineFieldNames) {
      const lines = linesFromValue(JSON.parse(data.get(name) || "[]"));
      if (!lines.length) throw new Error(`${lineFieldTitles[name]} must contain at least one non-empty line.`);
      lineValues[name] = lines;
    }
    const brandingDetails = normalizeBrandingDetails(data.get("branding_details"))
      .map((line) => Object.fromEntries(Object.entries(line).map(([key, value]) => [key, String(value).trim()])));
    if (!brandingDetails.length || brandingDetails.some((line) => !line.mode
      || Object.values(line).some((value) => value.length > 200))) {
      throw new Error("Add at least one branding line, choose a mode for each line, and keep each field to 200 characters or fewer.");
    }
    const preferenceRecorded = data.get("preferred_designer") !== "__unknown";
    const preferredDesigner = preferenceRecorded ? data.get("preferred_designer") || null : null;
    const currentRow = allRows.find((row) => row.id === data.get("id"));
    if (!currentRow) throw new Error("This artwork is no longer available to update. Refresh the page and try again.");
    const referenceValues = {};
    if (currentRow.reference_type != null) {
      const referenceType = data.get("reference_type");
      const previousReference = String(data.get("previous_reference") || "").trim();
      if (!["new", "old"].includes(referenceType)) throw new Error("Choose New artwork or Old artwork.");
      if (referenceType === "old" && !previousReference) throw new Error("Enter the previous artwork reference number.");
      referenceValues.reference_type = referenceType;
      referenceValues.previous_reference = referenceType === "old" ? previousReference : null;
    }
    const { error } = await client.from("artwork_requests").update({
      category: data.get("category"), client_name: data.get("client_name"), ...referenceValues,
      ...lineValues, branding_details: brandingDetails,
      high_res_logo: data.has("high_res_logo"), redesign_logo: data.has("redesign_logo"),
      additional_info: data.get("additional_info") || null,
      preferred_designer: preferredDesigner,
      preferred_designer_recorded: preferenceRecorded,
      assigned_designer: data.get("assigned_designer") || null,
      status: data.get("status"),
      date_needed: data.get("date_needed"), designer_notes: data.get("designer_notes") || null
    }).eq("id", data.get("id"));
    if (error) throw error;
    document.querySelector("#admin-edit-dialog").close();
    toast("Artwork updated.");
    await refreshArtworks();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteArtwork(event) {
  const id = document.querySelector("#admin-edit-form").elements.id.value;
  if (!confirm("Delete this saved artwork and its change history? This cannot be undone.")) return;
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    const { error } = await client.from("artwork_requests").delete().eq("id", id);
    if (error) throw error;
    document.querySelector("#admin-edit-dialog").close();
    toast("Artwork deleted.");
    await refreshArtworks();
  } catch (error) {
    toast(error.message || "Could not delete artwork.", "error");
  } finally {
    setBusy(button, false);
  }
}

function exportCsv() {
  const columns = ["ref_no","sr","created_at","created_month","created_by","preferred_designer","assigned_designer","category","client_name","reference","product","branding_details","high_res_logo","redesign_logo","additional_info","date_needed","status","claimed_at","done_at","done_by","designer_notes","change_count","changes_done","updated_at"];
  const brandingCsvValue = (details) => normalizeBrandingDetails(details).map((line) =>
    [["Logo", line.logo], ["Mode", line.mode], ["Pantone", line.pantone], ["Size", line.size], ["Position", line.position]]
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`)
      .join("; ")
  ).join(" | ");
  const csvValue = (row, column) => column === "preferred_designer"
    ? preferredDesignerName(row)
    : ["created_by", "assigned_designer", "done_by"].includes(column) ? profileName(row[column])
    : column === "reference" ? artworkReferenceLabel(row)
    : column === "branding_details" ? brandingCsvValue(row.branding_details)
      : lineFieldNames.includes(column) ? linesFromValue(row[column]).join(" | ") : row[column];
  const csvCell = (value) => {
    const safeValue = /^[=+\-@]/.test(String(value ?? "")) ? `'${value}` : value;
    return `"${String(safeValue ?? "").replaceAll('"', '""')}"`;
  };
  const headers = columns.map((column) => column === "reference" ? "Reference" : column);
  const csv = [headers.join(","), ...filteredAdminRows().map((row) => columns.map((column) => csvCell(csvValue(row, column))).join(","))].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "promo-kings-artworks.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Filtered CSV exported.");
}

async function requirePasswordChange() {
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
      window.clearTimeout(artworkRealtimeTimer);
      void client.removeAllChannels();
    }, { once: true });
    await initPortal(client, profile, page, toast);
    bindLogoutHandlers();
    await requirePasswordChange();
    if (page === "sales.html") await initSales();
    if (page === "designer.html") await initDesigner();
    if (page === "admin.html") await initAdmin();
    if (page === "users.html") await initUsers({ profile });
    if (["deliveries.html", "production-store.html"].includes(page)) await initDeliveries();
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

function initializeDeliveryStickyScrollbar() {
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
  const productionEntry = isProductionStoreMode() && !deliveryEditId;
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
      input.required = productionEntry ? name === "item_name" : true;
      if (name !== "address") input.maxLength = type === "number" ? 5 : 200;
      if (type === "number") {
        input.min = "1";
        input.step = "1";
        input.inputMode = "numeric";
      }
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
    if (productionEntry || deliveryEditId || line.goods_status) {
      const label = document.createElement("label");
      label.textContent = "Goods status";
      const select = document.createElement("select");
      select.name = "goods_status";
      select.required = productionEntry;
      select.disabled = Boolean(deliveryEditId && line.goods_status);
      select.innerHTML = '<option value="">Choose goods status</option><option value="ready">Ready</option><option value="partial">Partially</option><option value="not_ready">Not ready</option>';
      select.value = line.goods_status || "";
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
  deliveryItemsState = {
    initial: existing.map((line) => ({ ...line })),
    lines: (existing.length ? existing : [{ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "", goods_status: "" }])
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

async function submitDelivery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const payload = Object.fromEntries(new FormData(form));
  const productionEntry = isProductionStoreMode() && !deliveryEditId;
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
  if (productionEntry) {
    items.forEach((line) => {
      if (!hasSoNumber(line.so_number)) line.so_number = "";
    });
    if (!items.length || items.some((line) => !line.item_name || !line.goods_status
      || line.item_name.length > 200 || line.so_number.length > 200 || line.address.length > 200
      || line.quantity && (!/^[1-9]\d*$/.test(line.quantity) || Number(line.quantity) > 99999))) {
      toast("Add an item name and goods status. Optional item details must be valid when entered.", "error");
      return;
    }
  } else if (!items.length || items.some((line) => !hasSoNumber(line.so_number) || !line.item_name || !line.address
    || !/^[1-9]\d*$/.test(line.quantity) || Number(line.quantity) > 99999)) {
    toast("Add complete item lines with a positive whole-number quantity.", "error");
    return;
  }
  if (!productionEntry && !payload.contact_number.trim()) {
    toast("Enter a contact number.", "error");
    return;
  }
  if (!productionEntry && !payload.delivery_time
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
        .eq("id", productionEditId).select("id,ref_no").single()
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
      }).select("id,ref_no").single();
    const { data, error } = result;
    if (error) throw error;
    deliveryOriginalItemPairs = null;
    toast(productionEditId
      ? `Production entry ${data.ref_no} updated.`
      : deliveryEditId
      ? `Delivery request submitted as ${data.ref_no}.`
      : productionEntry ? `Production entry saved as ${data.ref_no}.` : `Delivery request saved as ${data.ref_no}.`);
    if (productionEditId) {
      productionEditId = null;
      form.reset();
      form.elements.items.value = "[]";
      form.elements.salesperson_id.disabled = false;
      form.querySelector('[type="submit"]').textContent = "Request";
      form.querySelector('[type="reset"]').textContent = "Clear";
      form.classList.add("hidden");
      document.querySelector("#delivery-form-toggle").textContent = "New request";
    } else if (deliveryEditId) {
      closeDeliveryEdit();
    } else {
      form.reset();
      document.querySelector('[name="items"]').value = "[]";
      document.querySelector("#delivery-items-open").textContent = "Click to add item details";
      form.classList.add("hidden");
      document.querySelector("#delivery-form-toggle").textContent = "New request";
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
  if (!isProductionStoreMode() || !hasProductionStoreAccess(profile)
    || (row.created_by !== profile.id && row.created_by !== row.salesperson_id)) return;
  const form = document.querySelector("#delivery-request-form");
  if (!form.classList.contains("hidden") && !confirm("Discard the current unsaved delivery entry?")) return;
  productionEditId = row.id;
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
  form.elements.items.value = JSON.stringify(row.items || []);
  document.querySelector("#delivery-items-open").textContent = deliveryItemSummary(row.items);
  form.querySelector('[type="submit"]').textContent = "Save changes";
  form.querySelector('[type="reset"]').textContent = "Discard";
  form.classList.remove("hidden");
  document.querySelector("#delivery-form-toggle").textContent = "Close edit";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeProductionDeliveryEdit() {
  if (!productionEditId) return;
  productionEditId = null;
  deliveryOriginalItemPairs = null;
  const form = document.querySelector("#delivery-request-form");
  form.reset();
  form.elements.items.value = "[]";
  form.elements.salesperson_id.disabled = false;
  document.querySelector("#delivery-items-open").textContent = "Click to add item details";
  form.querySelector('[type="submit"]').textContent = "Request";
  form.querySelector('[type="reset"]').textContent = "Clear";
  form.classList.add("hidden");
  document.querySelector("#delivery-form-toggle").textContent = "New request";
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
  const role = profile.role;
  const productionAccess = role === "admin" || hasProductionAccess(profile);
  const dispatchAccess = role === "admin" || hasDispatchAccess(profile);
  const isAssignedSalesperson = role !== "admin" && row.salesperson_id === profile.id;
  if (row.dispatch_status === "Delivered") return "";
  const actions = [];
  if (productionAccess && row.production_status !== "Ready" && !isAssignedSalesperson) {
    const goodsReady = ["ready", "partial"].includes(deliveryGoodsStatus(row));
    actions.push(`<button class="primary" data-delivery-ready="${escapeHtml(row.id)}"${goodsReady ? "" : " disabled"}>Ready</button>`);
  }
  if (dispatchAccess && row.production_status === "Ready") {
    if (!row.dispatched_at && !isAssignedSalesperson) {
      actions.push(`<button class="primary" data-delivery-dispatch="${escapeHtml(row.id)}">Packed</button>`);
    } else if (row.dispatched_at) {
      const vehicleOptions = vehicleRows.map((vehicle) =>
        `<option value="${escapeHtml(vehicle.id)}"${row.vehicle_id === vehicle.id ? " selected" : ""}>${escapeHtml(vehicle.registration_number)} · ${escapeHtml(vehicle.description)}</option>`
      ).join("");
      const canDeliver = Boolean(row.transport && (row.transport !== "Company" || row.vehicle_id));
      actions.push(`<div class="dispatch-controls">
        <select data-transport="${escapeHtml(row.id)}" aria-label="Transport"><option value="">Choose transport</option><option${row.transport === "Client" ? " selected" : ""}>Client</option><option${row.transport === "Company" ? " selected" : ""}>Company</option></select>
        <select data-vehicle="${escapeHtml(row.id)}" aria-label="Vehicle" class="${row.transport === "Company" ? "" : "hidden"}"><option value="">Choose vehicle…</option>${vehicleOptions}</select>
        ${hasDispatchAccess(profile)
          ? `<button class="secondary" data-delivery-delivered="${escapeHtml(row.id)}"${canDeliver ? "" : ' disabled title="Choose transport and an active vehicle when using Company transport."'}>Delivered</button>`
          : row.transport && (row.transport !== "Company" || row.vehicle_id) ? `<button class="secondary" data-delivery-delivered="${escapeHtml(row.id)}">Delivered</button>` : ""}
      </div>`);
    }
  }
  return actions.join("");
}

function renderProductionGoodsChips(rows) {
  const root = document.querySelector("#production-goods-chips");
  if (!root) return;
  const counts = {
    pending: rows.filter((row) => !deliveryGoodsStatus(row) || ["partial", "not_ready"].includes(deliveryGoodsStatus(row))).length,
    ready: rows.filter((row) => deliveryGoodsStatus(row) === "ready").length,
    partial: rows.filter((row) => deliveryGoodsStatus(row) === "partial").length,
    not_ready: rows.filter((row) => deliveryGoodsStatus(row) === "not_ready").length,
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
  const contactName = row.contact_name?.trim() || "";
  const contactNumber = row.contact_number?.trim() || "";
  const salespersonContact = `${escapeHtml(contactName || "—")}${contactName && contactNumber ? " · " : " "}${escapeHtml(contactNumber || "—")}`;
  const contactDetails = [contactName, contactNumber].filter(Boolean).map(escapeHtml).join(" · ") || "—";
  const clientContact = `${escapeHtml(row.client_name || "—")}${hasProductionAccess(profile) || hasDispatchAccess(profile) ? "" : `<br><span class="muted">${profile.role === "salesperson"
    ? salespersonContact
    : contactDetails}</span>`}`;
  const itemsCell = `<td class="delivery-items-cell" data-delivery-items="${escapeHtml(row.id)}" role="button" tabindex="0" aria-label="View all items and SO numbers">${deliveryItemSummary(row.items)}</td>`;
  const brandingCell = `<td>${escapeHtml(deliveryBrandingModes(row).join(", ") || "—")}</td>`;
  const addressCell = `<td><span class="delivery-address-cell" title="${escapeHtml(deliveryAddress(row))}">${escapeHtml(deliveryAddress(row) || "—")}</span></td>`;
  const soNumberCell = `<td>${deliverySoNumberCell(row)}</td>`;
  const deliveryDateCell = `<td>${escapeHtml(row.delivery_date || "—")}${row.delivery_date ? `<br>${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}` : ""}</td>`;
  const groupedDeliveryDate = `<small class="delivery-secondary"><span class="delivery-date-value">${escapeHtml(row.delivery_date || "—")}</span>${row.delivery_date ? `<br><span class="delivery-time-value">${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}</span>` : ""}</small>`;
  const groupedClientContact = `${clientContact}<br><small class="delivery-secondary">${escapeHtml(deliveryAddress(row) || "—")}</small><br><small class="delivery-secondary">${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</small>`;
  const deliveryColumns = page === "production-store.html"
    ? `<td>${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</td><td>${escapeHtml(row.client_name || "—")}</td>${itemsCell}<td>${escapeHtml(row.delivery_date || "—")}</td><td>${deliveryGoodsStatus(row)
      ? `<span class="delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatus(row) === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>`
      : "—"}</td>`
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
  const productionCell = `<td>${deliveryProductionStatusMarkup(row)}</td>`;
  const urgent = deliveryAddressUrgent(row);
  const missingAddressMarker = profile.role === "salesperson" && urgent
      ? '<br><small class="delivery-address-urgent">URGENT: address missing</small>'
      : "";
  const dispatchCell = `<td>${deliveryDispatchStatusMarkup(row)}${missingAddressMarker}</td>`;
  const canView = ["admin", "production", "dispatch", "salesperson"].includes(profile.role)
    || hasProductionAccess(profile) || hasDispatchAccess(profile) || isProductionStoreMode();
  const viewButton = canView ? `<button type="button" class="secondary" data-delivery-view="${escapeHtml(row.id)}">View</button>` : "";
  const actionsCell = `<td><div class="delivery-table-actions">${viewButton}${!isProductionStoreMode() && canSalespersonEditDelivery(row) ? `<button type="button" class="primary" data-delivery-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${isProductionStoreMode() && hasProductionStoreAccess(profile) && (row.created_by === profile.id || row.created_by === row.salesperson_id) ? `<button type="button" class="primary" data-production-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${profile.role === "admin" ? `<button type="button" class="danger" data-delivery-delete="${escapeHtml(row.id)}">Delete</button>` : ""}${deliveryActions(row)}</div></td>`;
  const rowDataCells = page === "production-store.html" || page === "deliveries.html"
    && (deliveryOperationalRole() === "production" || profile.role === "salesperson" && !isDeliveryRoleChipMode())
    ? deliveryColumns
    : `<td>${escapeHtml(row.sr)}</td>${deliveryDateCell}${deliveryColumns}`;
  const rowLabel = deliverySoNumbers(row).join(", ") || row.ref_no || row.sr;
  const rowViewAttributes = page === "deliveries.html" && canView
    ? ` data-row-view tabindex="0" role="button" aria-label="${escapeHtml(`View delivery ${rowLabel}`)}"` : "";
  return `<tr data-entry-id="${escapeHtml(row.id)}"${rowViewAttributes}${profile.role === "salesperson" && urgent ? ' class="delivery-address-urgent-row"' : ""}>${rowDataCells}${productionCell}${dispatchCell}${actionsCell}</tr>`;
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

function renderDeliveryRows(changedIds = null, statusChangedIds = new Set()) {
  const tbody = document.querySelector("#delivery-rows");
  const matchingRows = deliveryRows.filter(deliveryMatchesBaseFilters);
  if (page === "production-store.html") renderProductionGoodsChips(matchingRows);
  const visibleRows = isDeliveryRoleChipMode()
    ? matchingRows.filter((row) => deliveryRoleStatusMatches(row, deliveryRoleStatusFilter))
    : page === "production-store.html"
    ? matchingRows.filter((row) => {
      const status = deliveryGoodsStatus(row);
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
        if (current && statusChangedIds.has(id)) void animateDeliveryRowExit(current);
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
      const readyCount = matchingRows.filter((row) => deliveryGoodsStatus(row) === "ready").length;
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
  root.querySelectorAll("[data-delivery-delete]").forEach((button) => button.addEventListener("click", () => {
    void deleteDelivery(button);
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
  root.querySelectorAll("[data-delivery-dispatch]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.deliveryDispatch;
    await updateDelivery(id, { dispatched_at: new Date().toISOString() }, button, "Delivery packed.");
  }));
  root.querySelectorAll("[data-delivery-delivered]").forEach((button) => button.addEventListener("click", () =>
    updateDelivery(button.dataset.deliveryDelivered, {
      dispatch_status: "Delivered",
      ...(profile.role === "admin" ? { delivered_at: new Date().toISOString() } : {})
    }, button, "Delivery marked Delivered.")));
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

async function openDeliveryFromDeepLink(id) {
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
      if (page === "production-store.html") await loadProductionStoreSalespeople();
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

function openDeliveryItemsView(row, trigger) {
  const items = Array.isArray(row.items) ? row.items : [];
  const soNumbers = deliverySoNumbers(row);
  const content = document.querySelector("#delivery-items-view-content");
  const goodsStatusColumn = page === "production-store.html" || deliveryEditId;
  content.innerHTML = `<h3>SO number(s)</h3><p>${soNumbers.length ? soNumbers.map(escapeHtml).join(", ") : "—"}</p><table><thead><tr><th>SO number</th><th>Item name</th><th>Quantity (pcs)</th><th>Address to deliver</th>${goodsStatusColumn ? "<th>Goods status</th>" : ""}</tr></thead><tbody>${items.map((item) =>
    `<tr><td>${escapeHtml(item.so_number)}</td><td>${escapeHtml(item.item_name)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(item.address)}</td>${goodsStatusColumn ? `<td>${escapeHtml(deliveryGoodsStatusLabel(item.goods_status))}</td>` : ""}</tr>`
  ).join("")}</tbody></table>`;
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

async function initDeliveries() {
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
      contactSuggestions.replaceChildren();
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
      clientSuggestions.replaceChildren();
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
      clientSuggestions.replaceChildren();
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
  if (hasDispatchAccess(profile) || profile.role === "admin") await loadActiveVehicles();
  const searchInput = document.querySelector("#delivery-search");
  searchInput.addEventListener("input", debounce(renderDeliveryRows, 200));
  if (page === "production-store.html") {
    const salespersonFilter = document.querySelector("#production-salesperson-filter");
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
    const productionEntry = isProductionStoreMode() && !deliveryEditId;
    clearDeliveryItemErrors();
    let firstInvalid = null;
    lines.forEach((line, index) => {
      const row = document.querySelectorAll("#delivery-item-lines .delivery-item-row")[index];
      const invalidFields = productionEntry
        ? [["item_name", !line.item_name.trim()], ["goods_status", !line.goods_status]]
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
    document.querySelector("#delivery-items-open").textContent = lines.map((line) =>
      `${line.item_name}${line.quantity ? ` × ${line.quantity} pcs` : ""}`).join(" · ");
    clearDeliveryItemErrors();
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


bootstrap();
