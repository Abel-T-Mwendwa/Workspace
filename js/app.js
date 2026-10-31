import { canSeeStatusBoard, hasProductionStoreAccess, hasRiderRequestAccess, hasRouteAdminAccess, homePageForRole, initPortal, isPortalPageAllowed } from "./portal.js";
import { currentNairobiTime, deliverySlotLabel, deliverySlotOptions, hourlySlots } from "./delivery-slots.js";
import { bindEditorKeyboard } from "./dialog-keyboard.js";
import { riderRequestAvailability, riderRequestSlots, validateRiderRequestSlot } from "./rider-request-slots.js";

const client = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});
const historyDialog = document.querySelector("#history-dialog");
historyDialog?.querySelector("[data-close-dialog]")?.addEventListener("click", () => historyDialog.close());
const page = location.pathname.split("/").pop();
const DEFAULT_GOODS_FILTER = "pending";
const LOGIN_AT_KEY = "loginAt";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const STATUS_BOARD_REFRESH_MS = 30000;
const STATUS_COLOURS = {
  ready: "green",
  partial: "orange",
  not_ready: "red",
  pending_details: "purple",
  requested: "blue",
  pending: "grey",
  queued: "grey",
  Pending: "grey",
  "Not ready": "red",
  "Partially ready": "orange",
  Ready: "green",
  "Awaiting salesperson": "purple",
  "In production": "blue",
  "In progress": "blue",
  Packed: "blue",
  "Not packed": "orange",
  "Not delivered": "blue",
  "On route": "teal",
  Delivered: "green",
  "On hold": "orange",
  Queued: "grey"
};
const STATUS_BOARD_STAGES = [
  ["production_store", "PRODUCTION STORE"],
  ["salesperson", "SALESPERSON"],
  ["production", "PRODUCTION"],
  ["dispatch", "DISPATCH"],
  ["delivered", "DELIVERED"]
];
const DELIVERY_ROLE_STATUS_LABELS = {
  production: [
    { value: "pending", label: "Pending", style: "pending" },
    { value: "Not ready", label: "Not ready", style: "not-ready" },
    { value: "Ready", label: "Ready", style: "ready" },
    { value: "all", label: "All", style: "all" }
  ],
  dispatch: [
    { value: "pending", label: "Pending", style: "pending" },
    { value: "ready-for-delivery", label: "Ready for delivery", style: "ready" },
    { value: "not-packed", label: "Not packed", style: "partial" },
    { value: "packed", label: "Packed", style: "ready" },
    { value: "Not delivered", label: "Not delivered", style: "partial" },
    { value: "Delivered", label: "Delivered", style: "ready" },
    { value: "all", label: "All", style: "all" }
  ]
};
const ROUTE_STATUS_CHIPS = [
  { value: "active", label: "Active", style: "pending" },
  { value: "Not started", label: "Not started", style: "partial" },
  { value: "Started", label: "Started", style: "ready" },
  { value: "In progress", label: "In progress", style: "ready" },
  { value: "Finished", label: "Finished", style: "ready" },
  { value: "Declined", label: "Declined", style: "not-ready" },
  { value: "", label: "All", style: "all" }
];
let session;
let profile;
let allRows = [];
let allChanges = [];
let allWorkNotes = [];
let workNotesByRequest = new Map();
let activeWorkNoteRequestId = null;
let users = [];
let deliveryRows = [];
let deliveryRoleStatusFilter = "pending";
let routeRiderChipFilter = "__unassigned";
let routeStatusChipFilter = "active";
let statusBoardRows = [];
let statusBoardProfiles = new Map();
let statusBoardSelectedStage = "all";
let statusBoardDispatchFilter = "";
let statusBoardRefreshTimer = null;
let statusBoardLoading = false;
let statusBoardUnknownStatuses = new Set();
let statusBoardReportedIssues = new Set();
let productionGoodsFilter = DEFAULT_GOODS_FILTER;
let deliveryTotalCount = 0;
let assignedPendingDeliveries = [];
let vehicleRows = [];
let riderJobRows = [];
let deliveryOffset = 0;
let deliveryQueryToken = 0;
let riderOffset = 0;
let riderQueryToken = 0;
let riderUsers = [];
let requesterNames = new Map();
let routeRiderTotalCount = 0;
const ROUTE_RIDER_FILTERS_KEY = "routeRiderFilters";
let activeRiderJobCount = 0;
let deliveryItemsState = { initial: [], lines: [] };
let deliveryEditId = null;
let productionEditId = null;
let endingSession = false;
let sessionExpiryTimer = null;
let designerChangeTrigger = null;
let designerBodyOverflow = "";
let designerRenderToken = 0;
const SORT_STATE_KEY = `artworkSort:${page}`;
const SORT_KEYS = ["sr", "created_month", "created_at", "ref_no", ...(page === "designer.html" ? ["date_needed"] : []), ...(["deliveries.html", "production-store.html"].includes(page) ? ["delivery_schedule"] : [])];
function readSortState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STATE_KEY) || "null");
    return saved && SORT_KEYS.includes(saved.key) && ["asc", "desc"].includes(saved.direction) ? saved : null;
  } catch (error) {
    console.error("Could not read the table sort preference.", error);
    return null;
  }
}
const savedSortState = ["deliveries.html", "production-store.html"].includes(page) ? null : readSortState();
let activeSort = savedSortState || (page === "designer.html"
  ? { key: "date_needed", direction: "desc" }
  : ["deliveries.html", "production-store.html"].includes(page) ? { key: "delivery_schedule", direction: "asc" }
    : { key: "sr", direction: "asc" });
let userSortKey = savedSortState?.key || (page === "designer.html" ? "date_needed" : ["deliveries.html", "production-store.html"].includes(page) ? "delivery_schedule" : null);
let donePopoverTrigger = null;

function debounce(callback, delay = 180) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function toast(message, type = "success") {
  const root = document.querySelector("#toast-root");
  root.replaceChildren();
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  root.append(item);
  setTimeout(() => item.remove(), 4200);
}

function isTypingTarget(target) {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function shortcutButton(root, selector) {
  const button = root?.querySelector(selector);
  return button && !button.disabled && !button.closest(".hidden") && button.getClientRects().length ? button : null;
}

function handleKeyboardShortcuts(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const openDialogs = [...document.querySelectorAll("dialog[open]")];
  const dialog = openDialogs.at(-1);

  if (event.key === "Escape") {
    closeDonePopover();
    if (!dialog) return;
    event.preventDefault();
    if (typeof dialog.requestClose === "function") {
      dialog.requestClose();
    } else {
      const cancelEvent = new Event("cancel", { cancelable: true });
      dialog.dispatchEvent(cancelEvent);
      if (!cancelEvent.defaultPrevented) dialog.close();
    }
    return;
  }

  if (isTypingTarget(event.target)) return;

  if (event.key === "+" || event.key === "=" && event.shiftKey) {
    const addButton = shortcutButton(dialog, "[data-shortcut-add]")
      || (!dialog && page === "sales.html" && profile?.role === "salesperson" ? shortcutButton(document, "#new-request") : null)
      || (!dialog && page === "deliveries.html" && ["salesperson", "admin"].includes(profile?.role)
        ? shortcutButton(document, "#delivery-form-toggle") : null);
    if (addButton) {
      event.preventDefault();
      addButton.click();
    }
    return;
  }

  if (event.key === "-" || event.key === "−") {
    const focusedRow = event.target instanceof Element
      ? event.target.closest(".line-editor-row, .branding-detail-row, .delivery-item-row") : null;
    const row = focusedRow || dialog?.querySelector(".line-editor-row:last-child, .branding-detail-row:last-child, .delivery-item-row:last-child");
    const removeButton = shortcutButton(row, "[data-shortcut-remove]")
      || (dialog?.id === "admin-edit-dialog" && profile?.role === "admin"
        ? shortcutButton(dialog, "#admin-delete") : null);
    if (removeButton) {
      event.preventDefault();
      removeButton.click();
    }
    return;
  }

  if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button"))) {
    const saveButton = shortcutButton(dialog, "[data-shortcut-save]");
    if (saveButton) {
      event.preventDefault();
      saveButton.click();
      return;
    }
    const form = dialog?.querySelector("form") || (event.target instanceof Element ? event.target.closest("form") : null);
    const submitButton = form?.querySelector('[type="submit"]:not(:disabled)');
    if (form && submitButton) {
      event.preventDefault();
      form.requestSubmit(submitButton);
    }
  }
}

document.addEventListener("keydown", handleKeyboardShortcuts);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

const lineFieldNames = ["product"];
const lineFieldTitles = {
  product: "Product with code and colour"
};
const brandingModes = [
  "Embroidery",
  "Screen printing",
  "Digital printing",
  "Sublimation",
  "DTF",
  "Embroidery/sublimation",
  "Large Format"
];
let lineDialog;
let lineDialogState;
let brandingDialog;
let brandingDialogState;
let assignmentNotifications = [];

function linesFromValue(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  return values.filter((line) => typeof line === "string").map((line) => line.trim()).filter(Boolean);
}

function lineSummary(lines) {
  if (!lines.length) return "Click to add";
  return `${lines[0]}${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`;
}

function lineFieldMarkup(name, value, { mode = "edit", recordId = "", direct = false } = {}) {
  const lines = linesFromValue(value);
  const payload = escapeHtml(JSON.stringify(lines));
  return `<div class="line-field-group">
    <input type="hidden" name="${name}" value="${payload}">
    <button type="button" class="line-field-box" data-line-field="${name}" data-line-value="${payload}" data-line-mode="${mode}" data-line-record="${escapeHtml(recordId)}" data-line-direct="${direct}" aria-haspopup="dialog" aria-required="${mode === "edit"}" aria-label="${escapeHtml(lineFieldTitles[name])}: ${escapeHtml(lineSummary(lines))}">${escapeHtml(lineSummary(lines))}</button>
  </div>`;
}

function makeLineDialog() {
  lineDialog = document.createElement("dialog");
  lineDialog.id = "line-editor-dialog";
  lineDialog.className = "line-editor-dialog";
  lineDialog.innerHTML = `<div class="line-dialog-content">
    <div class="section-heading"><h2 id="line-dialog-title"></h2><button type="button" class="icon-button" data-line-close aria-label="Close">×</button></div>
    <div id="line-dialog-list" class="line-dialog-list"></div>
    <p id="line-dialog-message" class="form-message" role="alert"></p>
    <div class="dialog-actions" id="line-dialog-actions"></div>
  </div>`;
  document.body.append(lineDialog);
  bindEditorKeyboard(lineDialog);
  lineDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    discardLineDialog();
  });
  lineDialog.addEventListener("click", (event) => {
    if (event.target === lineDialog) discardLineDialog();
  });
  lineDialog.querySelector("[data-line-close]").addEventListener("click", () => {
    if (lineDialogState?.mode === "view") closeLineDialog();
    else discardLineDialog();
  });
}

function renderLineDialog() {
  const { lines, mode } = lineDialogState;
  const editable = mode === "edit";
  lineDialog.querySelector("#line-dialog-title").textContent = lineFieldTitles[lineDialogState.field];
  lineDialog.querySelector("[data-line-close]").classList.toggle("hidden", !editable);
  const list = lineDialog.querySelector("#line-dialog-list");
  list.replaceChildren();
  lines.forEach((line, index) => {
    if (editable) {
      const row = document.createElement("div");
      row.className = "line-editor-row";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.value = line;
      input.setAttribute("aria-label", `Line ${index + 1}`);
      input.placeholder = `Line ${index + 1}`;
      input.addEventListener("input", () => { lineDialogState.lines[index] = input.value; });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.dataset.shortcutRemove = "";
      remove.textContent = "Remove line";
      remove.addEventListener("click", () => {
        if (lineDialogState.lines.length === 1) lineDialogState.lines[0] = "";
        else lineDialogState.lines.splice(index, 1);
        renderLineDialog();
        const nextInput = list.querySelectorAll("input")[Math.min(index, lineDialogState.lines.length - 1)];
        nextInput?.focus();
      });
      row.append(input, remove);
      list.append(row);
    } else {
      const item = document.createElement("p");
      item.className = "line-view-item";
      item.textContent = line;
      list.append(item);
    }
  });
  const actions = lineDialog.querySelector("#line-dialog-actions");
  actions.replaceChildren();
  if (editable) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary";
    add.dataset.shortcutAdd = "";
    add.textContent = "Add line";
    add.addEventListener("click", () => {
      lineDialogState.lines.push("");
      renderLineDialog();
      list.lastElementChild?.querySelector("input")?.focus();
    });
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "quiet";
    discard.textContent = "Discard changes";
    discard.addEventListener("click", discardLineDialog);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.dataset.shortcutSave = "";
    save.textContent = "Save changes";
    save.addEventListener("click", () => { void saveLineDialog(); });
    actions.append(add, discard, save);
  } else {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "primary";
    close.textContent = "Close";
    close.addEventListener("click", closeLineDialog);
    actions.append(close);
  }
}

function openLineDialog(trigger) {
  let values;
  try {
    values = JSON.parse(trigger.dataset.lineValue || "[]");
  } catch (error) {
    toast("Could not read these request details.", "error");
    return;
  }
  const lines = linesFromValue(values);
  const editable = trigger.dataset.lineMode !== "view";
  lineDialogState = {
    trigger,
    field: trigger.dataset.lineField,
    mode: editable ? "edit" : "view",
    direct: trigger.dataset.lineDirect === "true",
    recordId: trigger.dataset.lineRecord,
    initialLines: lines.length ? [...lines] : [""],
    lines: lines.length ? [...lines] : [""]
  };
  lineDialog.querySelector("#line-dialog-message").textContent = "";
  renderLineDialog();
  lineDialog.showModal();
  (editable ? lineDialog.querySelector("#line-dialog-list input") : lineDialog.querySelector("#line-dialog-actions button"))?.focus();
}

function lineDialogHasChanges() {
  return JSON.stringify(lineDialogState.lines) !== JSON.stringify(lineDialogState.initialLines);
}

function closeLineDialog() {
  const trigger = lineDialogState?.trigger;
  lineDialog.close();
  lineDialogState = null;
  if (trigger?.isConnected) trigger.focus();
}

function discardLineDialog() {
  if (!lineDialogState) return;
  if (lineDialogState.mode === "edit" && lineDialogHasChanges()
    && !window.confirm("Discard the unsaved changes to these lines?")) return;
  closeLineDialog();
}

async function saveLineDialog() {
  const state = lineDialogState;
  if (!state || state.saving) return;
  const lines = state.lines.map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    lineDialog.querySelector("#line-dialog-message").textContent = "Enter at least one non-empty line.";
    return;
  }
  if (state.direct) {
    state.saving = true;
    const saveButton = lineDialog.querySelector("[data-shortcut-save]");
    setBusy(saveButton, true);
    try {
      const { data, error } = await client.from("artwork_requests").update({ [state.field]: lines })
        .eq("id", state.recordId).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("This request can no longer be edited. Refresh the page and try again.");
    } catch (error) {
      lineDialog.querySelector("#line-dialog-message").textContent = error.message || "Could not save these lines.";
      state.saving = false;
      setBusy(saveButton, false);
      return;
    }
    state.saving = false;
    setBusy(saveButton, false);
    const row = allRows.find((item) => item.id === state.recordId);
    if (row) row[state.field] = lines;
    toast("Request details updated.");
  }
  const group = state.trigger.closest(".line-field-group");
  const hidden = group?.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = JSON.stringify(lines);
  state.trigger.dataset.lineValue = JSON.stringify(lines);
  state.trigger.textContent = lineSummary(lines);
  closeLineDialog();
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-line-field]");
  if (trigger) openLineDialog(trigger);
});

makeLineDialog();

function normalizeBrandingDetails(value) {
  let details = value;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      details = [];
    }
  }
  if (!Array.isArray(details)) return [];
  return details.filter((line) => line && typeof line === "object" && !Array.isArray(line)).map((line) => ({
    logo: String(line.logo ?? ""),
    mode: String(line.mode ?? ""),
    pantone: String(line.pantone ?? ""),
    size: String(line.size ?? ""),
    position: String(line.position ?? "")
  }));
}

function brandingLineSummary(line) {
  return [line.mode, line.logo, line.pantone, line.size, line.position].filter(Boolean).join(" · ");
}

function brandingSummary(details) {
  const lines = normalizeBrandingDetails(details);
  const first = lines.length ? brandingLineSummary(lines[0]) : "";
  return `${first || "Click to add"}${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`;
}

function brandingFieldMarkup(value, { mode = "edit", recordId = "", direct = false } = {}) {
  const details = normalizeBrandingDetails(value);
  const payload = escapeHtml(JSON.stringify(details));
  return `<div class="branding-field-group">
    <input type="hidden" name="branding_details" value="${payload}">
    <button type="button" class="line-field-box" data-branding-field data-branding-value="${payload}" data-branding-mode="${mode}" data-branding-record="${escapeHtml(recordId)}" data-branding-direct="${direct}" aria-haspopup="dialog" aria-required="${mode === "edit"}" aria-label="Branding: ${escapeHtml(brandingSummary(details))}">${escapeHtml(brandingSummary(details))}</button>
  </div>`;
}

function makeBrandingDialog() {
  brandingDialog = document.createElement("dialog");
  brandingDialog.id = "branding-editor-dialog";
  brandingDialog.className = "line-editor-dialog branding-editor-dialog";
  brandingDialog.innerHTML = `<div class="line-dialog-content">
    <div class="section-heading"><h2 id="branding-dialog-title">Branding</h2><button type="button" class="icon-button" data-branding-close aria-label="Close">×</button></div>
    <div id="branding-dialog-list" class="line-dialog-list"></div>
    <p id="branding-dialog-message" class="form-message" role="alert"></p>
    <div class="dialog-actions" id="branding-dialog-actions"></div>
  </div>`;
  document.body.append(brandingDialog);
  bindEditorKeyboard(brandingDialog);
  brandingDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    discardBrandingDialog();
  });
  brandingDialog.addEventListener("click", (event) => {
    if (event.target === brandingDialog) discardBrandingDialog();
  });
  brandingDialog.querySelector("[data-branding-close]").addEventListener("click", () => {
    if (brandingDialogState?.mode === "view") closeBrandingDialog();
    else discardBrandingDialog();
  });
}

function renderBrandingDialog() {
  const { details, mode } = brandingDialogState;
  const editable = mode === "edit";
  brandingDialog.querySelector("[data-branding-close]").classList.toggle("hidden", !editable);
  const list = brandingDialog.querySelector("#branding-dialog-list");
  list.replaceChildren();
  details.forEach((detail, index) => {
    if (!editable) {
      const item = document.createElement("section");
      item.className = "branding-detail-view";
      const fields = [
        ["Logo to use", detail.logo],
        ["Mode of branding", detail.mode],
        ["Pantone code", detail.pantone],
        ["Size", detail.size],
        ["Position", detail.position]
      ];
      item.innerHTML = fields.filter(([, value]) => value).map(([label, value]) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join("") || "<p>No branding details saved.</p>";
      list.append(item);
      return;
    }

    const row = document.createElement("section");
    row.className = "branding-detail-row";
    const heading = document.createElement("h3");
    heading.textContent = `Branding line ${index + 1}`;
    const grid = document.createElement("div");
    grid.className = "branding-detail-grid";

    const textFields = [
      ["logo", "Logo to use"],
      ["pantone", "Pantone code"],
      ["size", "Size"],
      ["position", "Position"]
    ];
    const controls = new Map();
    textFields.forEach(([key, label]) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.value = detail[key];
      input.setAttribute("aria-label", `${label}, branding line ${index + 1}`);
      input.addEventListener("input", () => { detail[key] = input.value; });
      wrapper.append(input);
      controls.set(key, input);
      grid.append(wrapper);
    });

    const modeLabel = document.createElement("label");
    modeLabel.textContent = "Mode of branding";
    const select = document.createElement("select");
    select.required = true;
    select.setAttribute("aria-label", `Mode of branding, line ${index + 1}`);
    select.append(new Option("Select a mode…", ""));
    if (detail.mode && !brandingModes.includes(detail.mode)) {
      const legacyOption = new Option(`Previous value: ${detail.mode}`, detail.mode);
      legacyOption.hidden = true;
      select.append(legacyOption);
    }
    brandingModes.forEach((value) => select.append(new Option(value, value)));
    select.value = detail.mode;
    select.addEventListener("change", () => { detail.mode = select.value; });
    modeLabel.append(select);
    grid.insertBefore(modeLabel, grid.children[1] || null);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.shortcutRemove = "";
    remove.textContent = "Remove line";
    remove.addEventListener("click", () => {
      if (brandingDialogState.details.length === 1) {
        brandingDialogState.details[0] = { logo: "", mode: "", pantone: "", size: "", position: "" };
      } else {
        brandingDialogState.details.splice(index, 1);
      }
      renderBrandingDialog();
      const next = list.querySelectorAll(".branding-detail-row")[Math.min(index, brandingDialogState.details.length - 1)];
      next?.querySelector("input, select")?.focus();
    });
    row.append(heading, grid, remove);
    list.append(row);
    controls.get("logo")?.setAttribute("autocomplete", "off");
  });

  const actions = brandingDialog.querySelector("#branding-dialog-actions");
  actions.replaceChildren();
  if (!editable) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "primary";
    close.textContent = "Close";
    close.addEventListener("click", closeBrandingDialog);
    actions.append(close);
    return;
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.dataset.shortcutAdd = "";
  add.textContent = "Add line";
  add.addEventListener("click", () => {
    brandingDialogState.details.push({ logo: "", mode: "", pantone: "", size: "", position: "" });
    renderBrandingDialog();
    list.lastElementChild?.querySelector("input, select")?.focus();
  });
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "quiet";
  discard.textContent = "Discard changes";
  discard.addEventListener("click", discardBrandingDialog);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.dataset.shortcutSave = "";
  save.textContent = "Save changes";
  save.addEventListener("click", () => { void saveBrandingDialog(); });
  actions.append(add, discard, save);
}

function openBrandingDialog(trigger) {
  let details;
  try {
    details = normalizeBrandingDetails(JSON.parse(trigger.dataset.brandingValue || "[]"));
  } catch {
    toast("Could not read these branding details.", "error");
    return;
  }
  const editable = trigger.dataset.brandingMode !== "view";
  const lines = details.length ? details : [{ logo: "", mode: "", pantone: "", size: "", position: "" }];
  brandingDialogState = {
    trigger,
    mode: editable ? "edit" : "view",
    direct: trigger.dataset.brandingDirect === "true",
    recordId: trigger.dataset.brandingRecord,
    initialDetails: lines.map((line) => ({ ...line })),
    details: lines.map((line) => ({ ...line }))
  };
  brandingDialog.querySelector("#branding-dialog-message").textContent = "";
  renderBrandingDialog();
  brandingDialog.showModal();
  (editable
    ? brandingDialog.querySelector("#branding-dialog-list input, #branding-dialog-list select")
    : brandingDialog.querySelector("#branding-dialog-actions button"))?.focus();
}

function brandingDialogHasChanges() {
  return JSON.stringify(brandingDialogState.details) !== JSON.stringify(brandingDialogState.initialDetails);
}

function closeBrandingDialog() {
  const trigger = brandingDialogState?.trigger;
  brandingDialog.close();
  brandingDialogState = null;
  if (trigger?.isConnected) trigger.focus();
}

function discardBrandingDialog() {
  if (!brandingDialogState) return;
  if (brandingDialogState.mode === "edit" && brandingDialogHasChanges()
    && !window.confirm("Discard the unsaved branding changes?")) return;
  closeBrandingDialog();
}

async function saveBrandingDialog() {
  const state = brandingDialogState;
  if (!state || state.saving) return;
  const message = brandingDialog.querySelector("#branding-dialog-message");
  const details = state.details.map((line) => Object.fromEntries(
    Object.entries(line).map(([key, value]) => [key, String(value).trim()])
  ));
  const nonEmpty = details.filter((line) => Object.values(line).some(Boolean));
  if (!nonEmpty.length) {
    message.textContent = "Add at least one branding line and choose a mode.";
    return;
  }
  const invalid = nonEmpty.find((line) => !line.mode);
  if (invalid) {
    message.textContent = "Choose a mode of branding for every non-empty line.";
    const index = details.indexOf(invalid);
    brandingDialog.querySelectorAll(".branding-detail-row select")[index]?.focus();
    return;
  }
  if (nonEmpty.some((line) => Object.values(line).some((value) => value.length > 200))) {
    message.textContent = "Branding text must be 200 characters or fewer per field.";
    return;
  }
  state.saving = true;
  if (state.direct) {
    try {
      const { data, error } = await client.from("artwork_requests").update({ branding_details: nonEmpty })
        .eq("id", state.recordId).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("This request can no longer be edited. Refresh the page and try again.");
      const row = allRows.find((item) => item.id === state.recordId);
      if (row) row.branding_details = nonEmpty;
      toast("Branding details updated.");
    } catch (error) {
      message.textContent = error.message || "Could not save branding details.";
      state.saving = false;
      return;
    }
  }
  const group = state.trigger.closest(".branding-field-group");
  const hidden = group?.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = JSON.stringify(nonEmpty);
  state.trigger.dataset.brandingValue = JSON.stringify(nonEmpty);
  state.trigger.textContent = brandingSummary(nonEmpty);
  state.trigger.setAttribute("aria-label", `Branding: ${brandingSummary(nonEmpty)}`);
  closeBrandingDialog();
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-branding-field]");
  if (trigger) openBrandingDialog(trigger);
});

makeBrandingDialog();

function storedLoginAt() {
  try {
    const timestamp = Number(localStorage.getItem(LOGIN_AT_KEY));
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  } catch (error) {
    console.error("Could not read the session timestamp.", error);
    return null;
  }
}

function clearLoginAt() {
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch (error) {
    console.error("Could not clear the session timestamp.", error);
  }
}

function sessionIsWithinLimit() {
  const loginAt = storedLoginAt();
  const age = Date.now() - loginAt;
  return loginAt !== null && age >= 0 && age < SESSION_DURATION_MS;
}

function startVisibleRefresh(callback) {
  const refresh = () => {
    if (document.hidden) return;
    Promise.resolve(callback()).catch((error) => {
      toast(error.message || "Could not refresh this list.", "error");
    });
  };
  const timer = window.setInterval(() => {
    refresh();
  }, 30000);
  const onVisibilityChange = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }, { once: true });
  return timer;
}

async function endSession(message) {
  endingSession = true;
  clearLoginAt();
  const { error } = await client.auth.signOut();
  location.replace(`./index.html${message ? "?session=expired" : ""}`);
  if (error) throw error;
}

function monitorSessionExpiry() {
  const checkExpiry = () => {
    if (session && !sessionIsWithinLimit()) {
      void endSession("expired").catch((error) => toast(error.message || "Could not end the expired session.", "error"));
    }
  };
  sessionExpiryTimer = window.setInterval(checkExpiry, 60 * 1000);
}

function localDate(value) {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00+03:00`)
    : new Date(value);
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Nairobi" }).format(date);
}

function localDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(value));
}

function sortRows(rows) {
  const direction = activeSort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (activeSort.key === "sr") {
      comparison = Number(left.sr) - Number(right.sr);
    } else if (activeSort.key === "created_month") {
      comparison = String(left.created_month || "").localeCompare(String(right.created_month || ""));
    } else if (activeSort.key === "created_at") {
      comparison = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    } else if (activeSort.key === "ref_no") {
      comparison = String(left.ref_no || "").localeCompare(String(right.ref_no || ""), undefined, { numeric: true, sensitivity: "base" });
    } else if (activeSort.key === "date_needed") {
      const leftDate = left.date_needed ? Date.parse(`${left.date_needed}T00:00:00`) : NaN;
      const rightDate = right.date_needed ? Date.parse(`${right.date_needed}T00:00:00`) : NaN;
      if (!Number.isFinite(leftDate)) return Number.isFinite(rightDate) ? 1 : 0;
      if (!Number.isFinite(rightDate)) return -1;
      comparison = leftDate - rightDate;
    } else if (activeSort.key === "delivery_schedule") {
      const leftDay = left.delivery_date ? Date.parse(`${left.delivery_date}T00:00:00`) : NaN;
      const rightDay = right.delivery_date ? Date.parse(`${right.delivery_date}T00:00:00`) : NaN;
      if (!Number.isFinite(leftDay)) return Number.isFinite(rightDay) ? 1 : 0;
      if (!Number.isFinite(rightDay)) return -1;
      if (leftDay !== rightDay) {
        comparison = leftDay - rightDay;
      } else {
        const leftTime = left.delivery_time ? Date.parse(`${left.delivery_date}T${left.delivery_time}`) : NaN;
        const rightTime = right.delivery_time ? Date.parse(`${right.delivery_date}T${right.delivery_time}`) : NaN;
        if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
        if (!Number.isFinite(rightTime)) return -1;
        comparison = leftTime - rightTime;
      }
    }
    return comparison * direction;
  });
}

function updateSortIndicators() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const label = header.dataset.sortLabel || header.textContent.trim();
    header.dataset.sortLabel = label;
    header.title = page === "deliveries.html" || page === "designer.html" && header.dataset.sort === "date_needed" ? "Click to sort" : "Double-click to sort";
    header.classList.add("sortable-header");
    const active = header.dataset.sort === activeSort.key;
    header.textContent = `${label}${active ? (activeSort.direction === "asc" ? " ▲" : " ▼") : ""}`;
    header.setAttribute("aria-sort", active ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none");
  });
}

function bindSortableHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    header.addEventListener(page === "deliveries.html" || page === "designer.html" && header.dataset.sort === "date_needed" ? "click" : "dblclick", () => {
      activeSort = userSortKey === header.dataset.sort
        ? { key: activeSort.key, direction: activeSort.direction === "asc" ? "desc" : "asc" }
        : { key: header.dataset.sort, direction: "asc" };
      userSortKey = header.dataset.sort;
      if (page !== "deliveries.html") {
        try {
          localStorage.setItem(SORT_STATE_KEY, JSON.stringify(activeSort));
        } catch (error) {
          console.error("Could not save the table sort preference.", error);
        }
      }
      if (page === "sales.html") renderSales();
      else if (page === "designer.html") void renderDesigner();
      else if (page === "admin.html") renderAdminRows();
      else if (page === "deliveries.html") void loadDeliveries(true);
    });
  });
  updateSortIndicators();
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

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "Saving…";
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
  }
  button.disabled = busy;
}

async function invokeAdmin(action, payload = {}) {
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

function bindPasswordHints(root) {
  root.querySelectorAll("[data-password-hint]").forEach((hint) => {
    const input = hint.parentElement.querySelector('input[type="password"]');
    if (!input) return;
    const update = () => {
      hint.textContent = input.value.length >= 8
        ? "Password length is valid."
        : `Password must be at least 8 characters. (${input.value.length}/8)`;
    };
    input.addEventListener("input", update);
    update();
  });
}

async function loadUsers() {
  const { data, error } = await client.from("profiles").select("id,username,full_name,role,active,route_admin_access,production_store_access,rider_request_access,created_at").order("full_name");
  if (error) throw error;
  users = data || [];
  return users;
}

async function loadArtworks() {
  const { data, error } = await client.from("artwork_requests").select("*").order("sr", { ascending: true });
  if (error) throw error;
  allRows = data || [];
  if (allRows.length) {
    const changeResult = await client.from("artwork_changes").select("*").in("artwork_id", allRows.map((row) => row.id));
    if (changeResult.error) throw changeResult.error;
    allChanges = changeResult.data || [];
  } else {
    allChanges = [];
  }
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

function dateKey(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function periodBounds(period) {
  const key = dateKey(today);
  if (period === "week") {
    const date = new Date(`${key}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const start = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 7);
    const end = date.toISOString().slice(0, 10);
    return (value) => dateKey(value) >= start && dateKey(value) < end;
  }
  const length = period === "day" ? 10 : period === "month" ? 7 : 4;
  return (value) => dateKey(value).slice(0, length) === key.slice(0, length);
}

function tallyMarkup(items) {
  return items.map(([label, value]) => `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`).join("");
}

function periodDateRange(period) {
  const current = new Date(`${dateKey(today)}T00:00:00Z`);
  let start = new Date(current);
  let end = new Date(current);
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
  } else if (period === "month") {
    start.setUTCDate(1);
    end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
  } else {
    end.setUTCDate(end.getUTCDate() + 1);
  }
  const format = (value) => value.toISOString().slice(0, 10);
  return { from: format(start), to: format(end) };
}

async function activityCount(table, period, card) {
  let query = client.from(table).select("id", { count: "exact", head: true });
  if (card.dateColumn) {
    const range = periodDateRange(period);
    query = query.gte(card.dateColumn, `${range.from}T00:00:00+03:00`)
      .lt(card.dateColumn, `${range.to}T00:00:00+03:00`);
  }
  for (const [column, value] of Object.entries(card.filters || {})) {
    query = value === null ? query.is(column, null)
      : value === "notNull" ? query.not(column, "is", null) : query.eq(column, value);
  }
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function renderPeriodSummary(rootId, periodId, table, cards) {
  const root = document.querySelector(`#${rootId}`);
  const period = document.querySelector(`#${periodId}`)?.value || "day";
  const counts = await Promise.all(cards.map((card) => activityCount(table, period, card)));
  root.innerHTML = tallyMarkup(cards.map((card, index) => [card.label, counts[index]]));
}

function bindPeriodSummary(periodId, update) {
  const refresh = () => update().catch((error) => toast(error.message || "Could not load activity summary.", "error"));
  document.querySelector(`#${periodId}`)?.addEventListener("change", refresh);
  void refresh();
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
  startVisibleRefresh(refreshArtworks);
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

function protectSoNumberInput(input) {
  const updateValidity = () => {
    if (!/^SO-/i.test(input.value)) input.value = `${SO_NUMBER_PREFIX}${input.value}`;
    else input.value = `${SO_NUMBER_PREFIX}${input.value.slice(3)}`;
    input.setCustomValidity(hasSoNumber(input.value) ? "" : "Enter an SO number after SO-.");
  };
  input.addEventListener("focus", () => {
    if (/^SO-/i.test(input.value)) input.setSelectionRange(3, 3);
  });
  input.addEventListener("click", () => {
    if (/^SO-/i.test(input.value) && input.selectionStart < 3) input.setSelectionRange(3, 3);
  });
  input.addEventListener("keydown", (event) => {
    if (!/^SO-/i.test(input.value)) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (event.key === "Home" || event.key === "ArrowLeft" && start <= 3
      || event.key === "Backspace" && start === end && start <= 3
      || event.key === "Backspace" && start < 3
      || event.key === "Delete" && start < 3
      || event.key.length === 1 && !event.ctrlKey && !event.metaKey && start < 3) {
      event.preventDefault();
      input.setSelectionRange(3, 3);
    }
  });
  input.addEventListener("paste", (event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/^SO-/i, "");
    const start = Math.max(input.selectionStart, 3);
    const end = Math.max(input.selectionEnd, 3);
    input.value = `${SO_NUMBER_PREFIX}${input.value.slice(3, start)}${pasted}${input.value.slice(end)}`;
    const caret = start + pasted.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.addEventListener("input", updateValidity);
  updateValidity();
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
  const { data, error } = await client.from("artwork_changes").select("*").eq("artwork_id", artworkId).order("requested_on");
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
  startVisibleRefresh(refreshArtworks);
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

async function changesFor(artworkIds) {
  if (!artworkIds.length) return [];
  const { data, error } = await client.from("artwork_changes").select("*").in("artwork_id", artworkIds).eq("status", "open").order("requested_on", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function renderDesignerTallies() {
  try {
    const rows = visibleDesignerRows();
    const ids = rows.map((row) => row.id);
    const { data: changes, error } = ids.length
      ? await client.from("artwork_changes").select("id,artwork_id,status,requested_on,done_at").in("artwork_id", ids)
      : { data: [], error: null };
    if (error) throw error;
    const inPeriod = periodBounds(document.querySelector("#designer-period").value);
    const received = rows.filter((row) => inPeriod(row.created_at));
    const changesInPeriod = changes || [];
    document.querySelector("#designer-tallies").innerHTML = tallyMarkup([
      ["Requests received", received.length],
      ["Artworks done", rows.filter((row) => row.status === "Done" && inPeriod(row.done_at)).length],
      ["Artworks pending", received.filter((row) => row.status !== "Done").length],
      ["Changes requested", changesInPeriod.filter((change) => inPeriod(change.requested_on)).length],
      ["Changes done", changesInPeriod.filter((change) => change.status === "done" && inPeriod(change.done_at)).length]
    ]);
    document.querySelector("#change-count").textContent = changes?.length || 0;
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
    const openChanges = await changesFor(rows.map((row) => row.id));
    if (renderToken !== designerRenderToken) return;
    const assignedIds = new Set(assignmentNotifications.map((notice) => notice.artwork_id));
    const byArtwork = new Map();
    openChanges.forEach((change) => byArtwork.set(change.artwork_id, [...(byArtwork.get(change.artwork_id) || []), change]));
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
      if (filter === "changes") return byArtwork.has(row.id);
      if (filter === "changes-done") {
        const changes = allChangesByArtwork.get(row.id) || [];
        return changes.length > 0 && changes.every((change) => change.status === "done");
      }
      if (filter === "assignments") return assignedIds.has(row.id) && row.assigned_designer === profile.id;
      return true;
    }));
    const tbody = document.querySelector("#designer-rows");
    tbody.innerHTML = filtered.map((row) => {
      const changes = allChangesByArtwork.get(row.id) || [];
      const pendingChanges = changes.filter((change) => change.status !== "done");
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
          : `${statusBadge("Change requested")}${pendingChanges.filter((change) => change.change_text?.trim()).map((change) => `<div class="change-item"><button type="button" class="designer-change-request" data-change-request title="Click to view" aria-haspopup="dialog">${escapeHtml(change.change_text)}</button><small>${escapeHtml(change.requested_by)} · ${localDate(change.requested_on)}</small></div>`).join("")}`}</td>
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
    document.querySelector("#change-banner").classList.toggle("hidden", openChanges.length === 0);
    document.querySelector("#change-banner").textContent = openChanges.length ? `CHANGE REQUESTED · ${openChanges.length} change${openChanges.length === 1 ? "" : "s"} need attention` : "";
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
    void refreshArtworks();
  }).on("postgres_changes", { event: "*", schema: "public", table: "artwork_changes" }, () => {
    void refreshArtworks();
  }).on("postgres_changes", { event: "*", schema: "public", table: "artwork_work_notes" }, () => {
    void refreshArtworks();
  });
  if (page === "designer.html") {
    channel.on("postgres_changes", { event: "*", schema: "public", table: "designer_notifications" }, () => {
      void refreshArtworks();
    });
  }
  channel.subscribe();
}

async function refreshArtworks() {
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
  const previousIds = new Set(allRows.map((row) => row.id));
  const wasLoaded = allRows.length > 0;
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
  client.channel(`admin-artwork-${profile.id}`).on("postgres_changes", { event: "*", schema: "public", table: "artwork_requests" }, () => { void refreshArtworks(); }).subscribe();
  startVisibleRefresh(refreshArtworks);
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

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  if (String(new FormData(form).get("password")).length < 8) {
    toast("Password must be at least 8 characters.", "error");
    return;
  }
  setBusy(button, true);
  try {
    const formData = new FormData(form);
    const values = Object.fromEntries(formData);
    values.route_admin_access = formData.has("route_admin_access");
    values.production_store_access = formData.has("production_store_access");
    values.rider_request_access = formData.has("rider_request_access");
    await invokeAdmin("create_user", values);
    form.reset();
    toast("User created. Share the temporary password securely.");
    await loadUsers();
    renderUsers();
    renderUserTallies();
  } catch (error) {
    toast(error.message || "Could not create user.", "error");
  } finally {
    setBusy(button, false);
  }
}

function renderUsers() {
  const roleOptions = [...document.querySelector("#user-create-form [name='role']").options]
    .map((option) => ({ value: option.value, label: option.textContent }));
  const roleFilter = document.querySelector("#users-role-filter");
  if (roleFilter.options.length === 1) {
    roleFilter.innerHTML += roleOptions.map((role) =>
      `<option value="${escapeHtml(role.value)}">${escapeHtml(role.label)}</option>`
    ).join("");
  }
  const search = document.querySelector("#users-search").value.trim().toLowerCase();
  const selectedRole = roleFilter.value;
  const activeFilter = document.querySelector("#users-active-filter").value;
  const filteredUsers = users.filter((user) =>
    (!search || `${user.full_name} ${user.username}`.toLowerCase().includes(search))
    && (!selectedRole || user.role === selectedRole)
    && (!activeFilter || user.active === (activeFilter === "active")));
  document.querySelector("#users-results-count").textContent = `Showing ${filteredUsers.length} ${filteredUsers.length === 1 ? "user" : "users"}`;
  document.querySelector("#users-empty").classList.toggle("hidden", filteredUsers.length > 0);
  document.querySelector("#user-rows").innerHTML = filteredUsers.map((user) => `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.username)}</td>
    <td><select data-role="${escapeHtml(user.id)}">${roleOptions.map((role) => `<option value="${escapeHtml(role.value)}"${user.role === role.value ? " selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select></td>
    <td><input type="checkbox" data-route-admin="${escapeHtml(user.id)}" ${user.route_admin_access || user.role === "route_admin" || user.role === "admin" ? "checked" : ""} ${user.role === "route_admin" || user.role === "admin" ? "disabled" : ""} aria-label="Route admin access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-production-store="${escapeHtml(user.id)}" ${user.production_store_access || user.role === "production_store" ? "checked" : ""} ${user.role === "production_store" ? "disabled" : ""} aria-label="Production store access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-rider-request="${escapeHtml(user.id)}" ${user.rider_request_access || user.role === "user" ? "checked" : ""} ${user.role === "user" ? "disabled" : ""} aria-label="Rider request access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-active="${escapeHtml(user.id)}" ${user.active ? "checked" : ""} aria-label="Active"></td><td><div class="table-actions">
    <button class="secondary" data-reset="${escapeHtml(user.id)}">Reset password</button><button class="quiet" data-view-password="${escapeHtml(user.id)}">View password</button>
    ${profile?.role === "admin" ? `<button class="danger" data-delete-user="${escapeHtml(user.id)}" ${user.id === profile.id || user.role === "admin" && users.filter((entry) => entry.role === "admin").length <= 1 ? "disabled" : ""}>Delete user</button>` : ""}</div></td></tr>`).join("");
  initializeScrollableTables(document.querySelector("#user-rows").closest("table"));
  document.querySelectorAll("[data-role]").forEach((select) => select.addEventListener("change", () => updateUser(select.dataset.role, { role: select.value }, select)));
  document.querySelectorAll("[data-route-admin]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.routeAdmin, { route_admin_access: input.checked }, input)));
  document.querySelectorAll("[data-production-store]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.productionStore, { production_store_access: input.checked }, input)));
  document.querySelectorAll("[data-rider-request]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.riderRequest, { rider_request_access: input.checked }, input)));
  document.querySelectorAll("[data-active]").forEach((input) => input.addEventListener("change", () => updateUser(input.dataset.active, { active: input.checked }, input)));
  document.querySelectorAll("[data-reset]").forEach((button) => button.addEventListener("click", () => {
    const form = document.querySelector("#password-form");
    form.reset(); form.elements.user_id.value = button.dataset.reset;
    document.querySelector("#password-dialog").showModal();
  }));
  document.querySelectorAll("[data-view-password]").forEach((button) => button.addEventListener("click", () => viewPassword(button.dataset.viewPassword, button)));
  document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(button)));
}

async function deleteUser(button) {
  const target = users.find((user) => user.id === button.dataset.deleteUser);
  if (profile?.role !== "admin" || !target) return;
  if (target.id === profile.id) {
    toast("You cannot delete your own account.", "error");
    return;
  }
  if (target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) {
    toast("The last remaining administrator cannot be deleted.", "error");
    return;
  }
  if (!confirm(`Delete user ${target.full_name}? This cannot be undone.`)) return;
  setBusy(button, true, "Deleting…");
  try {
    await invokeAdmin("delete_user", { user_id: target.id });
    await loadUsers();
    renderUsers();
    renderUserTallies();
    toast(`User ${target.full_name} deleted.`);
  } catch (error) {
    toast(error.message || "Could not delete user.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function updateUser(id, changes, control) {
  setBusy(control, true);
  try {
    const values = changes.role === "production_store"
      ? { ...changes, production_store_access: true }
      : changes.role === "user" ? { ...changes, rider_request_access: true } : changes;
    const { error } = await client.from("profiles").update(values).eq("id", id);
    if (error) throw error;
    toast("User updated.");
    await loadUsers();
    renderUsers();
    renderUserTallies();
  } catch (error) {
    toast(error.message || "Could not update user.", "error");
    await loadUsers();
    renderUsers();
  } finally {
    setBusy(control, false);
  }
}

function renderUserTallies() {
  const roleOptions = ["salesperson", "designer", "production", "production_store", "dispatch", "route_admin", "rider", "user", "admin"];
  const activeCount = users.filter((user) => user.active).length;
  const inPeriod = periodBounds(document.querySelector("#users-period").value);
  document.querySelector("#user-tallies").innerHTML = tallyMarkup([
    ["Total users", users.length],
    ["Active users", activeCount],
    ["Created in period", users.filter((user) => inPeriod(user.created_at)).length],
    ...roleOptions.map((role) => [role === "production_store" ? "Production store" : role === "user" ? "User" : role.replace("_", " "), users.filter((user) => user.role === role).length])
  ]);
}

async function initUsers() {
  await loadUsers();
  renderUsers();
  renderUserTallies();
  document.querySelector("#users-search").addEventListener("input", renderUsers);
  document.querySelector("#users-role-filter").addEventListener("change", renderUsers);
  document.querySelector("#users-active-filter").addEventListener("change", renderUsers);
  document.querySelector("#users-clear-filters").addEventListener("click", () => {
    document.querySelector("#users-search").value = "";
    document.querySelector("#users-role-filter").value = "";
    document.querySelector("#users-active-filter").value = "";
    renderUsers();
  });
  document.querySelector("#users-period").addEventListener("change", renderUserTallies);
  document.querySelector("#user-create-form").addEventListener("submit", createUser);
  document.querySelector("#password-form").addEventListener("submit", resetPassword);
  bindPasswordHints(document);
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
}

async function resetPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  if (String(new FormData(form).get("password")).length < 8) {
    toast("Password must be at least 8 characters.", "error");
    return;
  }
  setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    await invokeAdmin("reset_password", values);
    document.querySelector("#password-dialog").close();
    toast("Password reset successfully.");
  } catch (error) {
    toast(error.message || "Could not reset password.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function viewPassword(userId, button) {
  setBusy(button, true, "Loading…");
  try {
    const result = await invokeAdmin("view_password", { user_id: userId });
    document.querySelector("#view-password-value").textContent = result.password;
    document.querySelector("#view-password-dialog").showModal();
  } catch (error) {
    toast(error.message || "Could not view password.", "error");
  } finally {
    setBusy(button, false);
  }
}

client.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" && !endingSession) location.replace("./index.html");
});
function bindLogoutHandlers() {
  document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await endSession();
    } catch (error) {
      toast(error.message || "Could not sign out.", "error");
      button.disabled = false;
    }
  }));
}

async function bootstrap() {
  initializeScrollableTables();
  try {
    const { data: { session: activeSession } } = await client.auth.getSession();
    session = activeSession;
    if (!session) return location.replace("./index.html");
    if (!sessionIsWithinLimit()) {
      await endSession("expired");
      return;
    }
    const { data: currentProfile, error } = await client.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (error) throw error;
    if (!currentProfile?.active) {
      await endSession();
      return;
    }
    profile = currentProfile;
    if (profile.role === "admin" && page === "my-jobs.html") {
      location.replace("./home.html");
      return;
    }
    if (!isPortalPageAllowed(page, profile)) {
      location.replace(`./${profile.role === "user" ? "riders.html" : homePageForRole()}`);
      return;
    }
    monitorSessionExpiry();
    window.addEventListener("pagehide", () => {
      if (sessionExpiryTimer !== null) window.clearInterval(sessionExpiryTimer);
      void client.removeAllChannels();
    }, { once: true });
    await initPortal(client, profile, page, toast);
    bindLogoutHandlers();
    await requirePasswordChange();
    if (page === "sales.html") await initSales();
    if (page === "designer.html") await initDesigner();
    if (page === "admin.html") await initAdmin();
    if (page === "users.html") await initUsers();
    if (["deliveries.html", "production-store.html"].includes(page)) await initDeliveries();
    if (page === "riders.html") await initRiders();
    if (page === "route-admin.html") await initRiders();
    if (page === "vehicles.html") await initVehicles();
    if (page === "my-jobs.html") await initMyJobs();
    if (page === "status-board.html") await initStatusBoard();
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
const PAGE_SIZE = 20;
const DELIVERY_FILTERS_KEY = "deliveryFilters";
let deliverySalespersonNames = new Map();

function isProductionStoreMode() {
  return page === "production-store.html";
}

let tableRowSliderObserver;

function tableColumnWidth(header, index) {
  const label = header.textContent.trim().toLowerCase();
  if (index === 0 && /^(sr|#|no\.?)(\s*\/.*)?$/.test(label)) return 82;
  if (index === 0 && /^ref(\s+no\.?)?$/.test(label)) return 140;
  if (/^(route admin access|production store access|rider request access|active)$/.test(label)) return 116;
  if (/^(action|actions|manage)$/.test(label)) return 270;
  if (/(^| )status$/.test(label) || /^(production|dispatch|type|category)$/.test(label)) return 150;
  if (/(date|time|needed|requested|delivery|expected)$/.test(label)) return 156;
  if (/^(quantity|quantity \(pcs\))$/.test(label)) return 132;
  if (/^(name|username|salesperson|rider|designer preferred|client|client \/ contact|ref no|ref \/ client|registration)$/.test(label)) return 184;
  if (/(item|address|details|description|product|branding|notes|reference|expected|transport|vehicle)/.test(label)) return 224;
  return 164;
}

function initializeScrollableTables(root = document) {
  const tables = root instanceof HTMLTableElement ? [root] : [...root.querySelectorAll("table")];
  tables.forEach((table) => {
    table.classList.add("table-scroll-content");
    const headers = [...table.querySelectorAll("thead th")];
    const widths = headers.map(tableColumnWidth);
    if (!widths.length) return;
    table.style.setProperty("--table-scroll-width", `${widths.reduce((total, width) => total + width, 0)}px`);
    headers.forEach((header, index) => {
      header.style.width = `${widths[index]}px`;
    });
    table.querySelectorAll("tr").forEach((row) => {
      [...row.cells].forEach((cell, index) => {
        if (widths[index] !== undefined) cell.style.width = `${widths[index]}px`;
      });
    });
  });

  if (root !== document || tableRowSliderObserver || !document.body) return;
  tableRowSliderObserver = new MutationObserver((records) => {
    const changedTables = new Set();
    records.forEach(({ target, addedNodes }) => {
      if (target instanceof Element) {
        const table = target.closest("table");
        if (table) changedTables.add(table);
      }
      addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node instanceof HTMLTableElement) changedTables.add(node);
        else node.querySelectorAll("table").forEach((table) => changedTables.add(table));
      });
    });
    changedTables.forEach((table) => initializeScrollableTables(table));
  });
  tableRowSliderObserver.observe(document.body, { childList: true, subtree: true });
}

function deliveryReadTable() {
  return !isProductionStoreMode() && ["production", "dispatch"].includes(profile.role)
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

function deliverySoNumbers(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return [...new Set(items.map((item) => String(item.so_number || "").trim()).filter(Boolean))];
}

function deliveryAddress(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return [...new Set(items.map((item) => String(item.address || "").trim()).filter(Boolean))].join(" · ");
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

function deliveryGoodsStatusLabel(status) {
  return ({ ready: "Ready", partial: "Partially", not_ready: "Not ready" })[status] || "—";
}

function deliveryGoodsStatus(row) {
  return row.goods_status || "";
}

function statusBoardStageOf(row) {
  if (row.delivered_at) return "delivered";
  if (row.production_status === "Ready" || row.dispatched_at || row.dispatch_status === "Delivered") return "dispatch";
  if (!row.goods_status) return "production";
  if (row.goods_status === "ready" && row.handoff_status === "requested") return "production";
  if (row.goods_status === "ready" && row.handoff_status === "pending_details") return "salesperson";
  return ["partial", "not_ready"].includes(row.goods_status) ? "production_store" : "production";
}

function statusBoardDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}

function statusBoardColour(value) {
  if (!value) return "grey";
  const colour = STATUS_COLOURS[value];
  if (!colour) {
    if (!statusBoardUnknownStatuses.has(value)) {
      statusBoardUnknownStatuses.add(value);
      console.warn(`Status board encountered an unmapped status: ${value}`);
    }
    return "grey";
  }
  return colour;
}

function statusBoardDisplayStatus(row, stage) {
  if (stage === "production_store") {
    return row.goods_status === "ready" ? "Ready"
      : row.goods_status === "partial" ? "Partially ready"
        : row.goods_status === "not_ready" ? "Not ready" : row.goods_status || "—";
  }
  if (stage === "salesperson") {
    return row.handoff_status === "pending_details" ? "Awaiting salesperson"
      : row.handoff_status === "requested" ? "Requested" : row.handoff_status || "—";
  }
  if (stage === "production") return row.production_status || "—";
  if (stage === "dispatch") {
    if (row.dispatch_status === "Delivered") return "Delivered";
    return row.dispatched_at ? "Not delivered" : "Not packed";
  }
  return row.dispatch_status === "Delivered" ? "Delivered" : row.dispatch_status || "—";
}

function statusBoardRecordColour(row, stage) {
  return statusBoardColour(statusBoardDisplayStatus(row, stage));
}

function statusBoardDateRangeIncludes(row, stage) {
  if (stage !== "delivered") return true;
  const from = document.querySelector("#status-board-date-from").value;
  const to = document.querySelector("#status-board-date-to").value;
  if (!from && !to) return true;
  const deliveredDate = statusBoardDate(row.delivered_at);
  return Boolean(deliveredDate && (!from || deliveredDate >= from) && (!to || deliveredDate <= to));
}

function statusBoardBuildView() {
  const search = document.querySelector("#status-board-search").value.trim().toLowerCase();
  const salespersonId = document.querySelector("#status-board-salesperson").value;
  const stages = Object.fromEntries(STATUS_BOARD_STAGES.map(([key]) => [key, []]));
  const statusCounts = Object.fromEntries(STATUS_BOARD_STAGES.map(([key]) => [key, new Map()]));
  const visibleRows = [];
  for (const row of statusBoardRows) {
    const name = statusBoardProfiles.get(row.salesperson_id || row.created_by) || "";
    if (salespersonId && (row.salesperson_id || row.created_by) !== salespersonId) continue;
    if (search) {
      const values = [row.sr, row.ref_no, row.client_name, name, ...deliverySoNumbers(row)];
      if (!values.some((value) => String(value || "").toLowerCase().includes(search))) continue;
    }
    const stage = statusBoardStageOf(row);
    if (!statusBoardDateRangeIncludes(row, stage)) continue;
    visibleRows.push(row);
    stages[stage].push(row);
    const label = statusBoardDisplayStatus(row, stage);
    if (label !== "—") {
      const counts = statusCounts[stage];
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return { stages, statusCounts, visibleRows };
}

function statusBoardRenderSalespeople() {
  const select = document.querySelector("#status-board-salesperson");
  const selected = select.value;
  const people = [...new Set(statusBoardRows.map((row) => row.salesperson_id || row.created_by).filter(Boolean))]
    .map((id) => [id, statusBoardProfiles.get(id) || "—"])
    .filter(([, name]) => name !== "—")
    .sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML = '<option value="">All salespeople</option>' + people.map(([id, name]) =>
    `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
  ).join("");
  if (people.some(([id]) => id === selected)) select.value = selected;
}

function statusBoardRenderSummary(stages) {
  const openCount = STATUS_BOARD_STAGES.filter(([key]) => key !== "delivered")
    .reduce((sum, [key]) => sum + stages[key].length, 0);
  const summary = [
    ["Open requests", openCount, "blue"],
    ["Awaiting salesperson", stages.salesperson.length, "purple"],
    ["In production", stages.production.length, "orange"],
    ["In dispatch", stages.dispatch.length, "blue"],
    ["Delivered in range", stages.delivered.length, "green"]
  ];
  document.querySelector("#status-board-summary").innerHTML = summary.map(([label, count, colour]) =>
    `<article class="status-board-summary-card status-board-summary-${colour}"><span>${escapeHtml(label)}</span><strong>${count}</strong></article>`
  ).join("");
  const from = document.querySelector("#status-board-date-from").value || "any date";
  const to = document.querySelector("#status-board-date-to").value || "any date";
  document.querySelector("#status-board-date-count").textContent = `${stages.delivered.length} delivered between ${from} and ${to}`;
}

function statusBoardMeasureTop() {
  const board = document.querySelector("#status-board-kanban");
  if (!board) return;
  const top = Math.max(0, board.getBoundingClientRect().top);
  document.documentElement.style.setProperty("--board-top", `${top}px`);
}

function statusBoardRenderStageTabs(stages) {
  const root = document.querySelector("#status-board-stage-tabs");
  const allStageCount = STATUS_BOARD_STAGES.reduce((sum, [stage]) =>
    sum + stages[stage].length, 0);
  const tabs = [["all", "All stages", allStageCount], ...STATUS_BOARD_STAGES.map(([key, label]) =>
    [key, label, stages[key].length]
  )];
  const children = [];
  tabs.forEach(([key, label, count], index) => {
    if (index) {
      const separator = document.createElement("span");
      separator.className = "status-board-stage-separator";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "›";
      children.push(separator);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "status-board-stage-tab";
    button.dataset.stage = key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", key === "all" ? "status-board-kanban" : "status-board-stage-table-panel");
    button.setAttribute("aria-selected", String(statusBoardSelectedStage === key));
    button.tabIndex = statusBoardSelectedStage === key ? 0 : -1;
    const dot = document.createElement("span");
    dot.className = "status-board-stage-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "status-board-stage-label";
    name.textContent = label;
    const countPill = document.createElement("span");
    countPill.className = "status-board-stage-count";
    countPill.textContent = String(count);
    button.append(dot, name, countPill);
    button.addEventListener("click", () => {
      statusBoardSelectedStage = key;
      statusBoardDispatchFilter = "";
      statusBoardRender();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.querySelectorAll('[role="tab"]')];
      const index = buttons.indexOf(button);
      buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus();
    });
    children.push(button);
  });
  root.replaceChildren(...children);
}

function statusBoardStatusCounts(counts) {
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => `${count} ${label}`).join(" · ");
}

function statusBoardItems(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  if (!items.length) return "—";
  const first = `${String(items[0].item_name || "—")} × ${String(items[0].quantity || "—")} pcs`;
  return `${first}${items.length > 1 ? ` +${items.length - 1} more` : ""}`;
}

function statusBoardFullItems(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  if (!items.length) return "—";
  return items.map((item) =>
    `${String(item.item_name || "—")} × ${String(item.quantity || "—")} pcs`
  ).join(" · ");
}

function statusBoardSort(rows, stage) {
  return [...rows].sort((a, b) => {
    const timeA = new Date((stage === "dispatch" ? a.ready_at : stage === "delivered" ? a.delivered_at : a.created_at) || a.created_at || 0).getTime() || 0;
    const timeB = new Date((stage === "dispatch" ? b.ready_at : stage === "delivered" ? b.delivered_at : b.created_at) || b.created_at || 0).getTime() || 0;
    return stage === "delivered" ? timeB - timeA : timeA - timeB;
  });
}

function statusBoardCard(row, stage) {
  const colour = statusBoardRecordColour(row, stage);
  const status = statusBoardDisplayStatus(row, stage);
  const soNumbers = deliverySoNumbers(row);
  const salesperson = statusBoardProfiles.get(row.salesperson_id || row.created_by) || "—";
  const href = stage === "production_store" ? "./production-store.html" : "./deliveries.html";
  const items = statusBoardFullItems(row);
  return `<a class="status-board-card status-board-card-${colour}" href="${href}?open=${escapeHtml(encodeURIComponent(row.id))}" aria-label="SR ${escapeHtml(row.sr)}, ${escapeHtml(row.ref_no)}, ${escapeHtml(status)}">
    <div class="status-board-card-heading"><strong>${escapeHtml(soNumbers.join(", ") || "—")}</strong><span class="status-board-status status-board-status-${colour}">${escapeHtml(status)}</span></div>
    ${row.client_name?.trim() ? `<div class="status-board-card-client">${escapeHtml(row.client_name)}</div>` : ""}
    <div class="status-board-card-meta">${escapeHtml(salesperson)} · ${escapeHtml(row.ref_no || "—")}</div>
    <div class="status-board-card-items" title="${escapeHtml(items)}">${escapeHtml(items)}</div>
  </a>`;
}

function statusBoardRenderKanban(stages, statusCounts, selectedStage = "all") {
  const root = document.querySelector("#status-board-kanban");
  const visibleStages = selectedStage === "all"
    ? STATUS_BOARD_STAGES
    : STATUS_BOARD_STAGES.filter(([stage]) => stage === selectedStage);
  root.innerHTML = visibleStages.map(([stage, label]) => {
    const filteredRows = stage === "dispatch" && selectedStage === "dispatch" && statusBoardDispatchFilter
      ? stages[stage].filter((row) => statusBoardDispatchStatus(row) === statusBoardDispatchFilter)
      : stages[stage];
    const stageRows = statusBoardSort(filteredRows, stage);
    const counts = filteredRows === stages[stage] ? statusCounts[stage]
      : new Map(stageRows.map((row) => statusBoardDisplayStatus(row, stage))
        .reduce((map, status) => map.set(status, (map.get(status) || 0) + 1), new Map()));
    return `<section class="status-board-column status-board-column-${stage}" data-stage="${stage}"><header><h2>${escapeHtml(label)} <span class="status-board-column-count">${stageRows.length}</span></h2><p>${escapeHtml(statusBoardStatusCounts(counts))}</p></header>
      <div class="status-board-column-cards">${stageRows.length
        ? stageRows.map((row) => statusBoardCard(row, stage)).join("")
        : `<p class="status-board-nothing">${stage === "delivered" ? "No deliveries in this date range" : "Nothing here"}</p>`}</div></section>`;
  }).join("");
}

function statusBoardDispatchStatus(row) {
  return row.dispatch_status === "Delivered" ? "Delivered" : row.dispatched_at ? "Not delivered" : "Not packed";
}

function statusBoardRenderDispatchFilters(rows) {
  const root = document.querySelector("#status-board-dispatch-filters");
  const values = new Map();
  rows.forEach((row) => {
    const label = statusBoardDispatchStatus(row);
    values.set(label, (values.get(label) || 0) + 1);
  });
  const options = [["", "All", rows.length], ...[...values].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => [label, label, count])];
  root.classList.toggle("hidden", statusBoardSelectedStage !== "dispatch");
  if (statusBoardSelectedStage !== "dispatch") return;
  root.replaceChildren(...options.map(([value, label, count]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "status-board-dispatch-chip";
    button.textContent = `${label} ${count}`;
    button.setAttribute("aria-pressed", String(statusBoardDispatchFilter === value));
    button.addEventListener("click", () => {
      statusBoardDispatchFilter = value;
      statusBoardRender();
    });
    return button;
  }));
}

function statusBoardRenderTable(stages, stage) {
  const panel = document.querySelector("#status-board-stage-table-panel");
  const kanban = document.querySelector("#status-board-kanban");
  const isTable = stage !== "all";
  panel.classList.toggle("hidden", !isTable);
  kanban.classList.toggle("hidden", isTable);
  if (!isTable) return;
  let stageRows = statusBoardSort(stages[stage], stage);
  if (stage === "dispatch") {
    if (statusBoardDispatchFilter) stageRows = stageRows.filter((row) => statusBoardDispatchStatus(row) === statusBoardDispatchFilter);
  }
  document.querySelector("#status-board-table-head").innerHTML = "<tr><th>DL reference</th><th>SR</th><th>SO number</th><th>Salesperson</th><th>Client name</th><th>Items</th><th>Status</th></tr>";
  const body = document.querySelector("#status-board-table-body");
  body.innerHTML = stageRows.map((row) => {
    const status = statusBoardDisplayStatus(row, stage);
    const colour = statusBoardRecordColour(row, stage);
    return `<tr tabindex="0" role="button" data-status-record="${escapeHtml(row.id)}">
      <td>${escapeHtml(row.ref_no || "—")}</td><td>${escapeHtml(row.sr || "—")}</td><td>${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</td>
      <td>${escapeHtml(statusBoardProfiles.get(row.salesperson_id || row.created_by) || "—")}</td><td>${escapeHtml(row.client_name || "—")}</td><td>${escapeHtml(statusBoardItems(row))}</td>
      <td><span class="status-board-status status-board-status-${colour}">${escapeHtml(status)}</span></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-status-record]").forEach((row) => {
    const open = () => statusBoardOpenTimeline(row.dataset.statusRecord);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  const empty = document.querySelector("#status-board-table-empty");
  empty.textContent = stage === "delivered" ? "No deliveries in this date range" : "Nothing here";
  empty.classList.toggle("hidden", stageRows.length > 0);
}

function statusBoardFormatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(date);
}

function statusBoardTimelineRows(row) {
  const current = statusBoardStageOf(row);
  const currentIndex = STATUS_BOARD_STAGES.findIndex(([key]) => key === current);
  return STATUS_BOARD_STAGES.map(([stage, label], index) => {
    const done = index < currentIndex || stage === "delivered" && current === "delivered";
    const isCurrent = stage === current && !done;
    const statusColour = statusBoardRecordColour(row, stage);
    const colour = done ? "green" : isCurrent ? statusColour : "grey";
    const whoId = stage === "production_store" ? row.created_by : stage === "salesperson" ? row.salesperson_id : null;
    const time = stage === "production_store" ? row.created_at
      : stage === "production" && row.production_status === "Ready" ? row.ready_at
        : stage === "dispatch" ? row.dispatched_at || row.ready_at
          : stage === "delivered" ? row.delivered_at : null;
    const who = whoId ? statusBoardProfiles.get(whoId) || "—" : "—";
    const status = statusBoardDisplayStatus(row, stage);
    const marker = done ? "✓" : isCurrent ? "●" : "○";
    return `<li class="status-board-timeline-step ${done ? "is-complete" : isCurrent ? `is-current status-board-timeline-${colour}` : "is-future"}">
      <span class="status-board-timeline-marker" aria-hidden="true">${marker}</span><div><strong>${escapeHtml(label)}</strong><span class="status-board-status status-board-status-${colour}">${escapeHtml(status)}</span>
      <small>Who: ${escapeHtml(who)} · When: ${escapeHtml(statusBoardFormatDateTime(time))}</small></div></li>`;
  }).join("");
}

function statusBoardOpenTimeline(id) {
  const row = statusBoardRows.find((record) => record.id === id);
  if (!row) return;
  document.querySelector("#status-board-dialog-title").textContent = `${row.ref_no || "Delivery"} · SR ${row.sr}`;
  document.querySelector("#status-board-timeline").innerHTML = `<ol class="status-board-timeline">${statusBoardTimelineRows(row)}</ol>`;
  document.querySelector("#status-board-dialog").showModal();
}

function statusBoardRender() {
  const { stages, statusCounts, visibleRows } = statusBoardBuildView();
  const phoneLayout = window.matchMedia("(max-width: 640px)").matches;
  const total = STATUS_BOARD_STAGES.reduce((sum, [stage]) => sum + stages[stage].length, 0);
  console.assert(total === visibleRows.length, "Status board stage counts must equal visible records.");
  STATUS_BOARD_STAGES.forEach(([stage]) => {
    const statusTotal = [...statusCounts[stage].values()].reduce((sum, count) => sum + count, 0);
    console.assert(statusTotal === stages[stage].length, `Status board ${stage} status counts must match its records.`);
  });
  console.assert(new Set(visibleRows.map((row) => row.id)).size === visibleRows.length, "A delivery must not appear in multiple stages.");
  statusBoardRenderSummary(stages);
  statusBoardRenderStageTabs(stages);
  statusBoardRenderDispatchFilters(stages.dispatch);
  if (phoneLayout) {
    statusBoardRenderKanban(stages, statusCounts, statusBoardSelectedStage);
    statusBoardRenderTable(stages, "all");
  } else {
    if (statusBoardSelectedStage === "all") statusBoardRenderKanban(stages, statusCounts);
    statusBoardRenderTable(stages, statusBoardSelectedStage);
  }
}

function statusBoardReportDataIssues(rows) {
  const issues = new Map([
    ["goods_status", []],
    ["client name", []],
    ["contact name", []]
  ]);
  rows.forEach((row) => {
    const stage = statusBoardStageOf(row);
    if (!row.goods_status) issues.get("goods_status").push(row);
    if (!row.client_name?.trim()) issues.get("client name").push(row);
    if (!row.contact_name?.trim()) issues.get("contact name").push(row);
    if (statusBoardDisplayStatus(row, stage) === "—" && row.goods_status) {
      if (!issues.has("stage status")) issues.set("stage status", []);
      issues.get("stage status").push(row);
    }
  });
  issues.forEach((affected, field) => {
    const unreported = affected.filter((row) => {
      const key = `${field}:${row.id}`;
      if (statusBoardReportedIssues.has(key)) return false;
      statusBoardReportedIssues.add(key);
      return true;
    });
    if (unreported.length) {
      console.warn(`Status board records missing ${field}:`, unreported.map((row) =>
        `SR ${row.sr || "—"} · ${row.ref_no || row.id}`));
    }
  });
}

function statusBoardCaptureScroll() {
  return {
    page: window.scrollY,
    columns: [...document.querySelectorAll(".status-board-column-cards")].map((column) => column.scrollTop),
    tableTop: document.querySelector("#status-board-stage-table-panel .table-wrap")?.scrollTop || 0,
    tableLeft: document.querySelector("#status-board-stage-table-panel .table-wrap")?.scrollLeft || 0
  };
}

function statusBoardRestoreScroll(scroll) {
  window.scrollTo(window.scrollX, scroll.page);
  document.querySelectorAll(".status-board-column-cards").forEach((column, index) => {
    column.scrollTop = scroll.columns[index] || 0;
  });
  const table = document.querySelector("#status-board-stage-table-panel .table-wrap");
  if (table) {
    table.scrollTop = scroll.tableTop;
    table.scrollLeft = scroll.tableLeft;
  }
}

async function statusBoardRefresh() {
  if (statusBoardLoading) return;
  statusBoardLoading = true;
  const scroll = statusBoardCaptureScroll();
  try {
    const [deliveryResult, profilesResult] = await Promise.all([
      client.from("deliveries")
        .select("id,sr,ref_no,created_at,created_by,salesperson_id,handoff_status,goods_status,client_name,contact_name,items,production_status,dispatch_status,ready_at,dispatched_at,delivered_at")
        .order("created_at", { ascending: false }).limit(1000),
      client.from("profiles").select("id,full_name").limit(1000)
    ]);
    if (deliveryResult.error) throw deliveryResult.error;
    if (profilesResult.error) throw profilesResult.error;
    statusBoardRows = deliveryResult.data || [];
    statusBoardProfiles = new Map((profilesResult.data || []).map((person) => [person.id, person.full_name]));
    statusBoardReportDataIssues(statusBoardRows);
    statusBoardRenderSalespeople();
    statusBoardRender();
    statusBoardRestoreScroll(scroll);
    statusBoardMeasureTop();
    const updated = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date());
    document.querySelector("#status-board-updated").textContent = `Updated ${updated}`;
  } catch (error) {
    toast(error.message || "Could not load the status board.", "error");
  } finally {
    statusBoardLoading = false;
  }
}

function statusBoardSelectTab(tabName, focus = false) {
  const tabs = [...document.querySelectorAll(".status-board-tabs [role='tab']")];
  tabs.forEach((tab) => {
    const selected = tab.id === `status-tab-${tabName}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.querySelector(`#${tab.getAttribute("aria-controls")}`);
    panel.hidden = !selected;
    panel.classList.toggle("hidden", !selected);
  });
  if (focus) document.querySelector(`#status-tab-${tabName}`).focus();
}

async function initStatusBoard() {
  if (!canSeeStatusBoard(profile)) {
    location.replace(`./${homePageForRole()}`);
    return;
  }
  const todayDate = statusBoardDate(new Date());
  document.querySelector("#status-board-date-from").value = todayDate;
  document.querySelector("#status-board-date-to").value = todayDate;
  document.querySelector("#status-board-search").addEventListener("input", debounce(statusBoardRender, 250));
  document.querySelector("#status-board-salesperson").addEventListener("change", statusBoardRender);
  document.querySelector("#status-board-date-from").addEventListener("change", statusBoardRender);
  document.querySelector("#status-board-date-to").addEventListener("change", statusBoardRender);
  window.addEventListener("resize", debounce(() => {
    statusBoardRender();
    statusBoardMeasureTop();
  }, 100));
  document.querySelector("#status-board-refresh").addEventListener("click", () => {
    void statusBoardRefresh();
  });
  document.querySelector("#status-board-display-mode").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const enabled = document.body.classList.toggle("status-board-display-mode");
    button.setAttribute("aria-pressed", String(enabled));
    requestAnimationFrame(statusBoardMeasureTop);
  });
  document.querySelector("#status-board-reset").addEventListener("click", () => {
    document.querySelector("#status-board-search").value = "";
    document.querySelector("#status-board-salesperson").value = "";
    document.querySelector("#status-board-date-from").value = todayDate;
    document.querySelector("#status-board-date-to").value = todayDate;
    statusBoardSelectedStage = "all";
    statusBoardDispatchFilter = "";
    statusBoardSelectTab("deliveries");
    statusBoardRender();
  });
  document.querySelectorAll("[data-date-range]").forEach((button) => button.addEventListener("click", () => {
    const todayValue = statusBoardDate(new Date());
    const todayStart = new Date(`${todayValue}T00:00:00+03:00`);
    const from = new Date(todayStart);
    if (button.dataset.dateRange === "week") from.setDate(from.getDate() - 6);
    if (button.dataset.dateRange === "month") from.setDate(1);
    document.querySelector("#status-board-date-from").value = statusBoardDate(from);
    document.querySelector("#status-board-date-to").value = todayValue;
    statusBoardRender();
  }));
  document.querySelectorAll(".status-board-tabs [role='tab']").forEach((tab) => {
    tab.addEventListener("click", () => statusBoardSelectTab(tab.id.replace("status-tab-", "")));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll(".status-board-tabs [role='tab']")];
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      statusBoardSelectTab(next.id.replace("status-tab-", ""), true);
    });
  });
  document.querySelectorAll("[data-status-dialog-close]").forEach((button) =>
    button.addEventListener("click", () => document.querySelector("#status-board-dialog").close())
  );
  document.querySelector("#status-board-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  await statusBoardRefresh();
  statusBoardRefreshTimer = window.setInterval(() => {
    if (!document.hidden) void statusBoardRefresh();
  }, STATUS_BOARD_REFRESH_MS);
  window.addEventListener("pagehide", () => {
    if (statusBoardRefreshTimer !== null) window.clearInterval(statusBoardRefreshTimer);
  }, { once: true });
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
      if (name === "so_number") protectSoNumberInput(input);
      input.addEventListener("input", () => {
        line[name] = input.value;
        input.classList.remove("field-error");
      });
      label.append(input);
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.shortcutRemove = "";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
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
  const items = deliveryItemsMarkup(parsedItems);
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
  if ((!productionEntry || payload.contact_number.trim())
    && !/^\+?[0-9][0-9 ()-]{6,30}$/.test(payload.contact_number.trim())) {
    toast("Enter a valid contact number.", "error");
    return;
  }
  if (payload.delivery_date && payload.delivery_date < today) {
    toast("Delivery date cannot be in the past.", "error");
    return;
  }
  if (!productionEntry && !payload.delivery_time
    || payload.delivery_time && payload.delivery_time !== "any" && (!hourlySlots().some((slot) => slot.start === payload.delivery_time)
      || payload.delivery_date === today && payload.delivery_time <= currentNairobiTime())) {
    toast("Choose an available one-hour delivery slot.", "error");
    return;
  }
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
        .eq("id", productionEditId).eq("created_by", profile.id).select("id,ref_no").single()
      : deliveryEditId
      ? await client.from("deliveries").update({
        ...values,
        salesperson_id: profile.id,
        handoff_status: "requested"
      }).eq("id", deliveryEditId).eq("salesperson_id", profile.id).eq("handoff_status", "pending_details").select("id,ref_no").single()
      : await client.from("deliveries").insert({
        ...values,
        created_by: profile.id,
        ...(productionEntry
          ? { salesperson_id: payload.salesperson_id, handoff_status: "pending_details" }
          : profile.role === "salesperson" ? { salesperson_id: profile.id } : {})
      }).select("id,ref_no").single();
    const { data, error } = result;
    if (error) throw error;
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
    await loadDeliveries(true);
    await refreshAssignedPendingDeliveries();
  } catch (error) {
    toast(error.message || "Could not save the delivery request.", "error");
  } finally {
    setBusy(button, false);
  }
}

function openDeliveryEdit(row) {
  if (profile.role !== "salesperson" || row.salesperson_id !== profile.id
    || row.handoff_status !== "pending_details" || deliveryGoodsStatus(row) !== "ready") return;
  const form = document.querySelector("#delivery-request-form");
  const dialog = document.querySelector("#delivery-edit-dialog");
  deliveryEditId = row.id;
  configureDeliveryForm(form);
  form.elements.client_name.value = row.client_name || "";
  form.elements.contact_name.value = row.contact_name || "";
  form.elements.contact_number.value = row.contact_number || "";
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
    || row.created_by !== profile.id) return;
  const form = document.querySelector("#delivery-request-form");
  if (!form.classList.contains("hidden") && !confirm("Discard the current unsaved delivery entry?")) return;
  productionEditId = row.id;
  form.elements.salesperson_id.value = row.salesperson_id;
  form.elements.salesperson_id.disabled = true;
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
  const { data, error } = await client.from("profiles").select("id,full_name")
    .eq("role", "salesperson").eq("active", true).order("full_name");
  if (error) throw error;
  const select = document.querySelector("#delivery-request-form").elements.salesperson_id;
  select.innerHTML = '<option value="">Choose salesperson</option>' + (data || []).map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`
  ).join("");
}

function deliveryStatusFilter(query) {
  if (["production", "dispatch"].includes(profile.role)) {
    query = query.neq("handoff_status", "pending_details");
  }
  if (page === "deliveries.html") {
    const dateFrom = document.querySelector("#delivery-date-from").value;
    const dateTo = document.querySelector("#delivery-date-to").value;
    const salesperson = document.querySelector("#delivery-salesperson").value;
    const production = isDeliveryRoleChipMode() ? "" : document.querySelector("#delivery-production-filter").value;
    const dispatch = isDeliveryRoleChipMode() ? "" : document.querySelector("#delivery-dispatch-filter").value;
    const search = document.querySelector("#delivery-search").value.trim();
    const orFilters = [];
    if (production) query = query.eq("production_status", production);
    if (dispatch === "not-packed") {
      query = query.eq("dispatch_status", "Not delivered").is("dispatched_at", null);
    } else if (dispatch === "packed") {
      query = query.eq("dispatch_status", "Not delivered").not("dispatched_at", "is", null);
    } else if (dispatch) {
      query = query.eq("dispatch_status", dispatch);
    }
    if (dateFrom) query = query.gte("delivery_date", dateFrom);
    if (dateTo) query = query.lte("delivery_date", dateTo);
    if (salesperson) {
      orFilters.push(`or(salesperson_id.eq.${salesperson},and(salesperson_id.is.null,created_by.eq.${salesperson}))`);
    }
    if (search) {
      const term = JSON.stringify(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      orFilters.push(`or(so_numbers_search.ilike.${term},client_name.ilike.${term})`);
    }
    if (orFilters.length) query = query.or(`and(${orFilters.join(",")})`);
    return query;
  }
  const filter = document.querySelector("#delivery-status-filter")?.value || "";
  if (filter === "Not ready") return query.eq("production_status", "Not ready");
  if (filter === "Ready") return query.eq("production_status", "Ready").eq("dispatch_status", "Not delivered");
  if (filter === "Not delivered") return query.eq("dispatch_status", "Not delivered").not("dispatched_at", "is", null);
  if (filter === "Delivered") return query.eq("dispatch_status", "Delivered");
  return query;
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
  const salespersonIds = new Set();
  let offset = 0;
  while (true) {
    const { data, error } = await client.from(deliveryReadTable())
      .select("salesperson_id,created_by")
      .order("sr")
      .range(offset, offset + 999);
    if (error) throw error;
    (data || []).forEach((row) => {
      const id = row.salesperson_id || row.created_by;
      if (id) salespersonIds.add(id);
    });
    if ((data || []).length < 1000) break;
    offset += 1000;
  }
  if (!salespersonIds.size) return;
  const { data, error } = await client.from("profiles").select("id,full_name")
    .eq("role", "salesperson").in("id", [...salespersonIds]).order("full_name");
  if (error) throw error;
  const users = data || [];
  deliverySalespersonNames = new Map(users.map((user) => [user.id, user.full_name]));
  select.innerHTML = '<option value="">All salespeople</option>' + users.map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.full_name)}</option>`
  ).join("");
  const savedValue = select.dataset.savedValue;
  if (savedValue && users.some((user) => user.id === savedValue)) select.value = savedValue;
}

async function loadProductionStoreSalespeople() {
  const ids = [...new Set(deliveryRows.map((row) => row.salesperson_id || row.created_by).filter(Boolean))];
  deliverySalespersonNames = new Map();
  if (ids.length) {
    const { data, error } = await client.from("profiles").select("id,full_name").in("id", ids).order("full_name");
    if (error) throw error;
    deliverySalespersonNames = new Map((data || []).map((user) => [user.id, user.full_name]));
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
  document.querySelector("#delivery-role-status-chips").classList.toggle("hidden", !roleChipMode);
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
      void loadDeliveries(true);
    });
  });
  document.querySelector("#delivery-clear-filters").addEventListener("click", () => {
    document.querySelector("#delivery-date-from").value = "";
    document.querySelector("#delivery-date-to").value = "";
    document.querySelector("#delivery-salesperson").value = "";
    document.querySelector("#delivery-production-filter").value = "";
    document.querySelector("#delivery-dispatch-filter").value = "";
    if (roleChipMode) {
      deliveryRoleStatusFilter = "pending";
      document.querySelector("#delivery-search").value = "";
    }
    saveDeliveryFilters();
    void loadDeliveries(true);
  });
  document.querySelector("#delivery-reset-filters").addEventListener("click", () => {
    document.querySelector("#delivery-date-from").value = "";
    document.querySelector("#delivery-date-to").value = "";
    document.querySelector("#delivery-salesperson").value = "";
    if (roleChipMode) {
      deliveryRoleStatusFilter = "pending";
      document.querySelector("#delivery-search").value = "";
    } else {
      document.querySelector("#delivery-production-filter").value = "Not ready";
      document.querySelector("#delivery-dispatch-filter").value = "Not delivered";
    }
    saveDeliveryFilters();
    void loadDeliveries(true);
  });
  saveDeliveryFilters();
}

async function queryDeliveryPage(offset, search = "", searchField = "ref_no") {
  const ascending = activeSort.direction === "asc";
  let query = deliveryStatusFilter(client.from(deliveryReadTable()).select(deliverySelect, { count: "exact" }));
  if (activeSort.key === "delivery_schedule") {
    query = query.order("delivery_date", { ascending, nullsFirst: false })
      .order("delivery_time", { ascending, nullsFirst: false });
  } else {
    const sortColumn = ["sr", "ref_no", "created_at"].includes(activeSort.key) ? activeSort.key : "sr";
    query = query.order(sortColumn, { ascending });
  }
  if (page !== "deliveries.html" && search) query = query.ilike(searchField, `%${search}%`);
  query = query.range(offset, offset + PAGE_SIZE - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data || [], count: count || 0 };
}

async function loadDeliveries(reset = true) {
  const token = ++deliveryQueryToken;
  const previousIds = new Set(deliveryRows.map((row) => row.id));
  const wasLoaded = deliveryRows.length > 0;
  if (reset) deliveryOffset = 0;
  const search = document.querySelector("#delivery-search")?.value.trim() || "";
  try {
    let result;
    if (page === "production-store.html") {
      const { data, error } = await client.from(deliveryReadTable()).select(deliverySelect)
        .order("sr", { ascending: false }).limit(1000);
      if (error) throw error;
      result = { rows: data || [], count: (data || []).length };
    } else if (page === "deliveries.html" || !search) {
      result = await queryDeliveryPage(deliveryOffset);
    } else {
      const results = await Promise.all([
        queryDeliveryPage(deliveryOffset, search, "ref_no"),
        queryDeliveryPage(deliveryOffset, search, "client_name")
      ]);
      const rows = results.flatMap((response) => response.rows)
        .filter((row, index, values) => values.findIndex((other) => other.id === row.id) === index);
      result = { rows, count: rows.length };
    }
    const pageRows = result.rows;
    if (token !== deliveryQueryToken) return;
    deliveryRows = reset ? pageRows : [...deliveryRows, ...pageRows.filter((row) => !deliveryRows.some((old) => old.id === row.id))];
    deliveryTotalCount = result.count;
    deliveryOffset = page === "production-store.html" ? pageRows.length : page === "deliveries.html"
      ? reset ? pageRows.length : deliveryOffset + pageRows.length
      : reset ? PAGE_SIZE : deliveryOffset + PAGE_SIZE;
    if (page === "production-store.html") await loadProductionStoreSalespeople();
    if (token !== deliveryQueryToken) return;
    renderDeliveryRows();
    if (wasLoaded) {
      document.querySelectorAll("#delivery-rows [data-entry-id]").forEach((row) => {
        if (!previousIds.has(row.dataset.entryId)) row.classList.add("portal-new-row");
      });
    }
    document.querySelector("#delivery-more")?.classList.toggle("hidden", page === "deliveries.html"
      ? deliveryOffset >= deliveryTotalCount
      : pageRows.length < PAGE_SIZE);
  } catch (error) {
    toast(error.message || "Could not load deliveries.", "error");
  }
}

async function loadActiveVehicles() {
  const { data, error } = await client.from("vehicles").select("id,registration_number,description")
    .eq("active", true).order("registration_number").limit(100);
  if (error) throw error;
  vehicleRows = data || [];
  return vehicleRows;
}

function deliveryActions(row) {
  const role = profile.role;
  if (row.handoff_status === "pending_details") return "";
  if (row.dispatch_status === "Delivered") return "";
  if ((role === "production" || role === "admin") && row.production_status !== "Ready") {
    return `<button class="primary" data-delivery-ready="${escapeHtml(row.id)}">Ready</button>`;
  }
  if (role === "dispatch" || role === "admin") {
    if (row.production_status !== "Ready") return "";
    if (!row.dispatched_at) return `<button class="primary" data-delivery-dispatch="${escapeHtml(row.id)}">Packed</button>`;
    const vehicleOptions = vehicleRows.map((vehicle) =>
      `<option value="${escapeHtml(vehicle.id)}"${row.vehicle_id === vehicle.id ? " selected" : ""}>${escapeHtml(vehicle.registration_number)} · ${escapeHtml(vehicle.description)}</option>`
    ).join("");
    return `<div class="dispatch-controls">
      <select data-transport="${escapeHtml(row.id)}" aria-label="Transport"><option value="">Choose transport</option><option${row.transport === "Client" ? " selected" : ""}>Client</option><option${row.transport === "Company" ? " selected" : ""}>Company</option></select>
      <select data-vehicle="${escapeHtml(row.id)}" aria-label="Vehicle" class="${row.transport === "Company" ? "" : "hidden"}"><option value="">Choose vehicle…</option>${vehicleOptions}</select>
      ${row.transport && (row.transport !== "Company" || row.vehicle_id) ? `<button class="secondary" data-delivery-delivered="${escapeHtml(row.id)}">Delivered</button>` : ""}
    </div>`;
  }
  return "";
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

function renderStatusChipButtons(root, chips, counts, selected, onSelect, dataName = "statusFilter") {
  root.replaceChildren(...chips.map(({ value, label, style }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `production-goods-chip production-goods-chip-${style}${selected === value ? " is-active" : ""}`;
    button.dataset[dataName] = value;
    button.setAttribute("aria-pressed", String(selected === value));
    button.setAttribute("aria-label", `${label} ${counts.get(value) ?? 0}`);
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "production-goods-chip-count";
    count.textContent = String(counts.get(value) ?? 0);
    button.append(name, count);
    button.addEventListener("click", () => {
      onSelect(value);
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.querySelectorAll("button")];
      const index = buttons.indexOf(button);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[nextIndex]?.focus();
    });
    return button;
  }));
}

function isDeliveryRoleChipMode() {
  return page === "deliveries.html" && ["production", "dispatch"].includes(profile.role);
}

function deliveryRoleStatusMatches(row, value) {
  if (value === "all") return true;
  if (profile.role === "production") {
    if (value === "pending") return row.goods_status === "ready" && row.production_status !== "Ready";
    return row.production_status === value;
  }
  if (value === "pending" || value === "not-packed") {
    const notPacked = row.production_status === "Ready" && row.dispatch_status === "Not delivered" && !row.dispatched_at;
    return value === "pending" ? notPacked : row.dispatch_status === "Not delivered" && !row.dispatched_at;
  }
  if (value === "ready-for-delivery" || value === "packed") {
    return row.dispatch_status === "Not delivered" && Boolean(row.dispatched_at);
  }
  if (value === "Not delivered") return row.dispatch_status === "Not delivered" && Boolean(row.dispatched_at);
  return row.dispatch_status === value;
}

function deliveryRoleStatusPills(rows) {
  const chips = DELIVERY_ROLE_STATUS_LABELS[profile.role];
  const counts = new Map(chips.map(({ value }) => [
    value,
    value === "all" ? rows.length : rows.filter((row) => deliveryRoleStatusMatches(row, value)).length
  ]));
  renderStatusChipButtons(document.querySelector("#delivery-role-status-chips"), chips, counts,
    deliveryRoleStatusFilter, (value) => {
      deliveryRoleStatusFilter = value;
      renderDeliveryRows();
    });
}

function renderDeliveryRows() {
  const tbody = document.querySelector("#delivery-rows");
  const dispatchValues = new Map([...tbody.querySelectorAll("[data-transport]")].map((select) => [
    select.dataset.transport,
    {
      transport: select.value,
      vehicle: tbody.querySelector(`[data-vehicle="${CSS.escape(select.dataset.transport)}"]`)?.value || ""
    }
  ]));
  const query = document.querySelector("#delivery-search")?.value.trim().toLowerCase() || "";
  const productionSalesperson = document.querySelector("#production-salesperson-filter")?.value || "";
  const matchingRows = deliveryRows.filter((row) => {
    if (page === "production-store.html") {
      const salesperson = deliverySalespersonName(row);
      return (!productionSalesperson || salesperson === productionSalesperson)
        && (!query || [salesperson, ...deliverySoNumbers(row), row.client_name]
          .some((value) => String(value || "").toLowerCase().includes(query)));
    }
    if (!query) return true;
    const searchable = page === "deliveries.html"
      ? [row.client_name, ...deliverySoNumbers(row)]
      : [row.ref_no, row.client_name, row.contact_name];
    return searchable.some((value) => String(value || "").toLowerCase().includes(query));
  });
  if (page === "production-store.html") renderProductionGoodsChips(matchingRows);
  if (isDeliveryRoleChipMode()) deliveryRoleStatusPills(matchingRows);
  const visibleRows = isDeliveryRoleChipMode()
    ? matchingRows.filter((row) => deliveryRoleStatusMatches(row, deliveryRoleStatusFilter))
    : page === "production-store.html"
    ? matchingRows.filter((row) => {
      const status = deliveryGoodsStatus(row);
      if (productionGoodsFilter === "pending") return !status || status === "partial" || status === "not_ready";
      if (productionGoodsFilter === "all") return true;
      return status === productionGoodsFilter;
    })
    : matchingRows;
  const filtered = page === "production-store.html" ? visibleRows : sortRows(visibleRows);
  tbody.innerHTML = filtered.map((row) => {
    const clientContact = `${escapeHtml(row.client_name || "—")}${["production", "dispatch"].includes(profile.role) ? "" : `<br><span class="muted">${row.contact_name || row.contact_number ? `${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}` : "—"}</span>`}`;
    const itemsCell = `<td class="delivery-items-cell" data-delivery-items="${escapeHtml(row.id)}" role="button" tabindex="0" aria-label="View all items and SO numbers">${deliveryItemSummary(row.items)}</td>`;
    const deliveryColumns = page === "production-store.html"
      ? `<td><strong>${escapeHtml(row.ref_no || "—")}</strong></td><td>${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</td><td>${escapeHtml(deliverySalespersonName(row))}</td><td>${escapeHtml(row.client_name || "—")}${row.contact_number ? `<br><small class="muted">${escapeHtml(row.contact_number)}</small>` : ""}</td>${itemsCell}<td>${deliveryGoodsStatus(row)
        ? `<span class="delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatus(row) === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>`
        : "—"}</td>`
      : page === "deliveries.html"
      ? `<td>${clientContact}</td><td><span class="delivery-address-cell" title="${escapeHtml(deliveryAddress(row))}">${escapeHtml(deliveryAddress(row) || "—")}</span></td><td>${deliverySoNumberCell(row)}</td>${itemsCell}<td>${escapeHtml(deliverySalespersonName(row))}</td><td>${deliveryGoodsStatus(row)
        ? `<span class="delivery-status-${deliveryGoodsStatus(row) === "ready" ? "green" : deliveryGoodsStatus(row) === "partial" ? "orange" : "red"}">${deliveryGoodsStatusLabel(deliveryGoodsStatus(row))}</span>`
        : "—"}</td>`
      : `<td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(localDateTime(row.created_at))}</td><td>${clientContact}</td>${itemsCell}`;
    return `<tr data-entry-id="${escapeHtml(row.id)}">
      <td>${escapeHtml(row.sr)}</td>${page === "production-store.html" ? "" : `<td>${escapeHtml(row.delivery_date || "—")}<br>${row.delivery_date ? escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time)) : "—"}</td>`}
      ${deliveryColumns}
      <td><span class="${row.handoff_status === "pending_details" ? "delivery-status-orange" : row.production_status === "Ready" ? "delivery-status-green" : "delivery-status-red"}">${row.handoff_status === "pending_details" ? "Awaiting salesperson" : escapeHtml(row.production_status)}</span>${row.ready_at ? `<br><small>${escapeHtml(localDateTime(row.ready_at))}</small>` : ""}</td>
      <td><span class="delivery-status-${row.dispatch_status === "Delivered" ? "green" : "orange"}">${row.dispatch_status === "Delivered" ? "Delivered" : row.dispatched_at ? "Not delivered" : "Not packed"}</span>${row.dispatched_at ? `<br><small>Packed ${escapeHtml(localDateTime(row.dispatched_at))}</small>` : ""}</td>
      <td><div class="delivery-table-actions">${["admin", "production", "dispatch", "salesperson"].includes(profile.role) || isProductionStoreMode() ? `<button type="button" class="secondary" data-delivery-view="${escapeHtml(row.id)}">View</button>` : ""}${profile.role === "salesperson" && !isProductionStoreMode() && row.salesperson_id === profile.id && row.handoff_status === "pending_details" && deliveryGoodsStatus(row) === "ready" ? `<button type="button" class="primary" data-delivery-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${isProductionStoreMode() && hasProductionStoreAccess(profile) && row.created_by === profile.id ? `<button type="button" class="primary" data-production-edit="${escapeHtml(row.id)}">Edit</button>` : ""}${profile.role === "admin" ? `<button type="button" class="danger" data-delivery-delete="${escapeHtml(row.id)}">Delete</button>` : ""}${deliveryActions(row)}</div></td></tr>`;
  }).join("");
  initializeScrollableTables(tbody.closest("table"));
  dispatchValues.forEach((values, id) => {
    const transport = tbody.querySelector(`[data-transport="${CSS.escape(id)}"]`);
    const vehicle = tbody.querySelector(`[data-vehicle="${CSS.escape(id)}"]`);
    if (transport) {
      transport.value = values.transport;
      vehicle?.classList.toggle("hidden", values.transport !== "Company");
    }
    if (vehicle && [...vehicle.options].some((option) => option.value === values.vehicle)) vehicle.value = values.vehicle;
  });
  const emptyState = document.querySelector("#delivery-empty");
  if (isDeliveryRoleChipMode() && !filtered.length) {
    emptyState.replaceChildren();
    const options = DELIVERY_ROLE_STATUS_LABELS[profile.role];
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
    const countLabel = deliveryTotalCount === 1 ? "delivery" : "deliveries";
    document.querySelector("#delivery-results-count").textContent = deliveryRows.length < deliveryTotalCount
      ? `Showing ${deliveryRows.length} of ${deliveryTotalCount} ${countLabel}`
      : `Showing ${deliveryRows.length} ${countLabel}`;
    const activeFilters = [];
    const dateFrom = document.querySelector("#delivery-date-from").value;
    const dateTo = document.querySelector("#delivery-date-to").value;
    const salesperson = document.querySelector("#delivery-salesperson");
    const production = document.querySelector("#delivery-production-filter").value;
    const dispatch = document.querySelector("#delivery-dispatch-filter");
    const search = document.querySelector("#delivery-search").value.trim();
    if (dateFrom || dateTo) activeFilters.push(`Delivery date: ${dateFrom || "any"}–${dateTo || "any"}`);
    if (salesperson.value) activeFilters.push(`Salesperson: ${salesperson.selectedOptions[0].textContent}`);
    if (production) activeFilters.push(`Production: ${production}`);
    if (dispatch.value) activeFilters.push(`Dispatch: ${dispatch.selectedOptions[0].textContent}`);
    if (search) activeFilters.push(`Search: ${search}`);
    document.querySelector("#delivery-active-filters").textContent = activeFilters.length
      ? `Active filters: ${activeFilters.join(" · ")}`
      : "No status, date, or salesperson filters";
  }
  updateSortIndicators();
  tbody.querySelectorAll("[data-delivery-ready]").forEach((button) => button.addEventListener("click", () =>
    updateDelivery(button.dataset.deliveryReady, {
      production_status: "Ready",
      ...(profile.role === "admin" ? { ready_at: new Date().toISOString() } : {})
    }, button, "Delivery marked Ready.")));
  tbody.querySelectorAll("[data-delivery-view]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.deliveryView);
    if (row) void openDeliveryView(row, button);
  }));
  tbody.querySelectorAll("[data-delivery-edit]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.deliveryEdit);
    if (row) openDeliveryEdit(row);
  }));
  tbody.querySelectorAll("[data-production-edit]").forEach((button) => button.addEventListener("click", () => {
    const row = deliveryRows.find((item) => item.id === button.dataset.productionEdit);
    if (row) openProductionDeliveryEdit(row);
  }));
  tbody.querySelectorAll("[data-delivery-delete]").forEach((button) => button.addEventListener("click", () => {
    void deleteDelivery(button);
  }));
  tbody.querySelectorAll("[data-delivery-items]").forEach((cell) => {
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
  tbody.querySelectorAll("[data-transport]").forEach((select) => select.addEventListener("change", async () => {
    const vehicle = tbody.querySelector(`[data-vehicle="${CSS.escape(select.dataset.transport)}"]`);
    vehicle?.classList.toggle("hidden", select.value !== "Company");
    if (vehicle && select.value !== "Company") vehicle.value = "";
    select.disabled = true;
    await updateDelivery(select.dataset.transport, {
      transport: select.value || null,
      vehicle_id: select.value === "Company" ? vehicle?.value || null : null
    }, null, "Transport saved.");
    if (select.isConnected) select.disabled = false;
  }));
  tbody.querySelectorAll("[data-vehicle]").forEach((select) => select.addEventListener("change", async () => {
    select.disabled = true;
    await updateDelivery(select.dataset.vehicle, {
      vehicle_id: select.value || null
    }, null, "Vehicle saved.");
    if (select.isConnected) select.disabled = false;
  }));
  tbody.querySelectorAll("[data-delivery-dispatch]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.deliveryDispatch;
    await updateDelivery(id, { dispatched_at: new Date().toISOString() }, button, "Delivery packed.");
  }));
  tbody.querySelectorAll("[data-delivery-delivered]").forEach((button) => button.addEventListener("click", () =>
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
  deliveryRows = deliveryRows.filter((delivery) => delivery.id !== id);
  renderDeliveryRows();
  toast(`Delivery ${row.ref_no} deleted.`);
  await loadDeliveries(true);
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
    if (page === "production-store.html") {
      document.querySelector("#production-salesperson-filter").value = "";
      productionGoodsFilter = "all";
      await loadDeliveries(true);
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
      await loadDeliveries(true);
    }

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
  const { data, error } = await client.from("profiles").select("full_name")
    .eq("id", row.salesperson_id || row.created_by).maybeSingle();
  if (error) {
    toast(error.message || "Could not load the salesperson name.", "error");
    return;
  }
  if (data?.full_name) requestedBy = data.full_name;
  let vehicleName = vehicleRows.find((vehicle) => vehicle.id === row.vehicle_id)?.registration_number || "—";
  if (row.vehicle_id && vehicleName === "—") {
    const vehicleResult = await client.from("vehicles").select("registration_number").eq("id", row.vehicle_id).maybeSingle();
    if (vehicleResult.error) {
      toast(vehicleResult.error.message || "Could not load the vehicle details.", "error");
      return;
    }
    vehicleName = vehicleResult.data?.registration_number || "—";
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
    ${["production", "dispatch"].includes(profile.role) ? "" : `<div><dt>Contact name</dt><dd>${escapeHtml(row.contact_name)}</dd></div>
    <div><dt>Contact number</dt><dd>${escapeHtml(row.contact_number)}</dd></div>`}
    <div><dt>Delivery date and time</dt><dd>${escapeHtml(row.delivery_date || "—")} · ${escapeHtml(row.delivery_time_any || !row.delivery_time ? "Any time" : deliverySlotLabel(row.delivery_time))}</dd></div>
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
    await loadDeliveries(true);
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
  try {
    const { data, error, count } = await client.from("deliveries").select(deliverySelect, { count: "exact" })
      .eq("salesperson_id", profile.id).eq("handoff_status", "pending_details").order("created_at");
    if (error) throw error;
    assignedPendingDeliveries = data || [];
    const pendingCount = count || assignedPendingDeliveries.length;
    notice.textContent = pendingCount === 1
      ? "1 production request is waiting for your details"
      : `${pendingCount} production requests are waiting for your details`;
    notice.classList.toggle("hidden", pendingCount === 0);
    notice.setAttribute("aria-label", notice.textContent);
  } catch (error) {
    toast(error.message || "Could not load assigned production entries.", "error");
  }
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
    document.querySelector("#delivery-salesperson-field")?.classList.toggle("hidden", !productionEntry);
    configureDeliveryForm(form, productionEntry);
    if (productionEntry) await loadDeliverySalespeople();
    form.elements.delivery_date.min = today;
    updateDeliverySlotOptions();
    form.elements.delivery_date.addEventListener("change", updateDeliverySlotOptions);
    document.querySelector("#delivery-form-toggle").addEventListener("click", () => {
      if (productionEditId) {
        closeProductionDeliveryEdit();
        return;
      }
      form.classList.toggle("hidden");
      document.querySelector("#delivery-form-toggle").textContent = form.classList.contains("hidden") ? "New request" : "Close request";
    });
    form.addEventListener("submit", submitDelivery);
    form.addEventListener("reset", () => {
      setTimeout(() => {
        document.querySelector('[name="items"]').value = "[]";
        document.querySelector("#delivery-items-open").textContent = "Click to add item details";
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
    document.querySelector("#delivery-handoff-notice").addEventListener("click", openFirstAssignedPendingDelivery);
    document.querySelector("[data-delivery-edit-cancel]").addEventListener("click", closeDeliveryEdit);
    document.querySelector("#delivery-edit-dialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDeliveryEdit();
    });
  }
  await refreshAssignedPendingDeliveries();
  if (profile.role === "dispatch" || profile.role === "admin") await loadActiveVehicles();
  if (page === "deliveries.html") await initializeDeliveryFilters();
  const searchInput = document.querySelector("#delivery-search");
  searchInput.addEventListener("input", page === "production-store.html"
    ? debounce(renderDeliveryRows, 200)
    : debounce(() => { void loadDeliveries(true); }));
  document.querySelector("#delivery-status-filter")?.addEventListener("change", () => { void loadDeliveries(true); });
  document.querySelector("#delivery-more")?.addEventListener("click", () => { void loadDeliveries(false); });
  if (page === "production-store.html") {
    const salespersonFilter = document.querySelector("#production-salesperson-filter");
    salespersonFilter.addEventListener("change", renderDeliveryRows);
    document.querySelector("#production-filter-reset").addEventListener("click", () => {
      searchInput.value = "";
      salespersonFilter.value = "";
      productionGoodsFilter = DEFAULT_GOODS_FILTER;
      renderDeliveryRows();
    });
  }
  document.querySelector("#delivery-item-add").addEventListener("click", () => {
    deliveryItemsState.lines.push({ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "", goods_status: "" });
    renderItemLineEditor();
    document.querySelector("#delivery-item-lines").lastElementChild?.querySelector("input")?.focus();
  });
  document.querySelector("#delivery-item-save").addEventListener("click", () => {
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
  const deliveryCards = ["production", "dispatch"].includes(profile.role)
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
  bindPeriodSummary("delivery-period", () => renderPeriodSummary("delivery-tallies", "delivery-period", deliveryReadTable(), deliveryCards));
  await loadDeliveries(true);
  client.channel(`deliveries-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "deliveries"
  }, () => {
    void loadDeliveries(true);
    void refreshAssignedPendingDeliveries();
  }).subscribe();
  if (profile.role === "dispatch" || profile.role === "admin") {
    client.channel(`delivery-vehicles-${profile.id}`).on("postgres_changes", {
      event: "*", schema: "public", table: "vehicles"
    }, async () => {
      await loadActiveVehicles();
      renderDeliveryRows();
    }).subscribe();
  }
  startVisibleRefresh(async () => {
    await loadDeliveries(true);
    await refreshAssignedPendingDeliveries();
    if (profile.role === "dispatch" || profile.role === "admin") {
      await loadActiveVehicles();
      renderDeliveryRows();
    }
  });
}

async function loadVehicles() {
  const { data, error } = await client.from("vehicles").select("id,registration_number,description,active,created_at")
    .order("registration_number").limit(200);
  if (error) throw error;
  vehicleRows = data || [];
  renderVehicles();
}

function renderVehicles() {
  const root = document.querySelector("#vehicle-rows");
  root.innerHTML = vehicleRows.map((vehicle) => `<tr data-entry-id="${escapeHtml(vehicle.id)}"><td>${escapeHtml(vehicle.registration_number)}</td><td>${escapeHtml(vehicle.description)}</td>
    <td>${vehicle.active ? "Active" : "Inactive"}</td><td><div class="table-actions"><button class="secondary" data-vehicle-edit="${escapeHtml(vehicle.id)}">Edit</button>
    <button class="quiet" data-vehicle-toggle="${escapeHtml(vehicle.id)}">${vehicle.active ? "Deactivate" : "Reactivate"}</button></div></td></tr>`).join("");
  initializeScrollableTables(root.closest("table"));
  document.querySelector("#vehicle-empty").classList.toggle("hidden", vehicleRows.length > 0);
  root.querySelectorAll("[data-vehicle-edit]").forEach((button) => button.addEventListener("click", () => {
    const vehicle = vehicleRows.find((item) => item.id === button.dataset.vehicleEdit);
    const form = document.querySelector("#vehicle-form");
    form.elements.id.value = vehicle.id;
    form.elements.registration_number.value = vehicle.registration_number;
    form.elements.description.value = vehicle.description;
    form.elements.active.checked = vehicle.active;
    form.querySelector('[type="submit"]').textContent = "Save vehicle";
  }));
  root.querySelectorAll("[data-vehicle-toggle]").forEach((button) => button.addEventListener("click", async () => {
    const vehicle = vehicleRows.find((item) => item.id === button.dataset.vehicleToggle);
    if (!vehicle) return;
    button.disabled = true;
    try {
      const { error } = await client.from("vehicles").update({ active: !vehicle.active }).eq("id", vehicle.id);
      if (error) throw error;
      await loadVehicles();
    } catch (error) {
      toast(error.message || "Could not update vehicle.", "error");
      button.disabled = false;
    }
  }));
}

async function initVehicles() {
  const form = document.querySelector("#vehicle-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      const data = new FormData(form);
      const values = {
        registration_number: String(data.get("registration_number")).trim().toUpperCase(),
        description: String(data.get("description")).trim(),
        active: data.has("active")
      };
      const id = data.get("id");
      const result = id
        ? await client.from("vehicles").update(values).eq("id", id)
        : await client.from("vehicles").insert({ ...values, created_by: profile.id });
      if (result.error) throw result.error;
      toast(id ? "Vehicle updated." : "Vehicle registered.");
      form.reset();
      form.elements.id.value = "";
      form.elements.active.checked = true;
      bindPeriodSummary("vehicle-period", async () => {
        await renderPeriodSummary("vehicle-tallies", "vehicle-period", "vehicles", [
          { label: "Total", filters: {} },
          { label: "Active", filters: { active: true } }
        ]);
        const used = await activityCount("deliveries", document.querySelector("#vehicle-period").value, {
          dateColumn: "dispatched_at", filters: { vehicle_id: "notNull" }
        });
        document.querySelector("#vehicle-tallies").insertAdjacentHTML("beforeend",
          `<div class="stat-card"><span>Used this period</span><strong>${used}</strong></div>`);
      });
      await loadVehicles();
    } catch (error) {
      toast(error.message || "Could not save vehicle.", "error");
    } finally {
      setBusy(button, false);
    }
  });
  document.querySelector("#vehicle-clear").addEventListener("click", () => {
    form.reset();
    form.elements.id.value = "";
    form.elements.active.checked = true;
  });
  await loadVehicles();
  client.channel(`vehicles-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "vehicles"
  }, () => { void loadVehicles(); }).subscribe();
  startVisibleRefresh(() => loadVehicles());
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

function routeRiderDateRange(period, currentDate = dateKey(new Date())) {
  if (period === "all") return null;
  const date = new Date(`${currentDate}T00:00:00Z`);
  const start = new Date(date);
  const end = new Date(date);
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
  } else if (period === "month") {
    start.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
  }
  const format = (value) => value.toISOString().slice(0, 10);
  return { from: format(start), to: format(end) };
}

function routeRiderFilterValues() {
  return {
    period: document.querySelector("#route-request-period").value,
    salesperson: document.querySelector("#route-salesperson-filter-select").value,
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
  if (["today", "week", "month", "all"].includes(saved.period)) {
    document.querySelector("#route-request-period").value = saved.period;
  }
  if (typeof saved.salesperson === "string") {
    document.querySelector("#route-salesperson-filter-select").dataset.savedValue = saved.salesperson;
  }
  if (typeof saved.rider === "string") routeRiderChipFilter = saved.rider;
  if (ROUTE_STATUS_CHIPS.some(({ value }) => value === saved.status)) {
    routeStatusChipFilter = saved.status;
  }
}

async function loadRouteSalespersonOptions() {
  const ids = new Set();
  let offset = 0;
  while (true) {
    const { data, error } = await client.from("rider_jobs").select("created_by")
      .order("created_at").range(offset, offset + 999);
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row.created_by) ids.add(row.created_by);
    });
    if ((data || []).length < 1000) break;
    offset += 1000;
  }
  const select = document.querySelector("#route-salesperson-filter-select");
  if (!ids.size) return;
  const { data, error } = await client.from("profiles").select("id,full_name")
    .eq("active", true).in("id", [...ids]).order("full_name");
  if (error) throw error;
  const people = data || [];
  people.forEach((person) => requesterNames.set(person.id, person.full_name));
  select.innerHTML = '<option value="">All salespeople</option>' + people.map((person) =>
    `<option value="${escapeHtml(person.id)}">${escapeHtml(person.full_name)}</option>`
  ).join("");
  const savedValue = select.dataset.savedValue;
  if (savedValue && people.some((person) => person.id === savedValue)) select.value = savedValue;
}

async function initializeRouteRiderFilters() {
  restoreRouteRiderFilters();
  routeRiderChipFilter = "__unassigned";
  routeStatusChipFilter = "active";
  await loadRouteSalespersonOptions();
  [
    "#route-request-period",
    "#route-salesperson-filter-select"
  ].forEach((selector) => {
    document.querySelector(selector).addEventListener("change", () => {
      saveRouteRiderFilters();
      void loadRiderJobs(true);
    });
  });
  document.querySelector("#route-clear-filters").addEventListener("click", () => {
    document.querySelector("#route-request-period").value = "all";
    document.querySelector("#route-salesperson-filter-select").value = "";
    routeRiderChipFilter = "";
    routeStatusChipFilter = "";
    saveRouteRiderFilters();
    void loadRiderJobs(true);
  });
  document.querySelector("#route-reset-filters").addEventListener("click", () => {
    document.querySelector("#route-search").value = "";
    document.querySelector("#route-request-period").value = "today";
    document.querySelector("#route-salesperson-filter-select").value = "";
    routeRiderChipFilter = "__unassigned";
    routeStatusChipFilter = "active";
    saveRouteRiderFilters();
    void loadRiderJobs(true);
  });
  saveRouteRiderFilters();
}

async function loadRiderJobs(reset = true) {
  const token = ++riderQueryToken;
  const previousIds = new Set(riderJobRows.map((row) => row.id));
  const wasLoaded = riderJobRows.length > 0;
  if (reset) riderOffset = 0;
  const routeAdmin = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const search = document.querySelector("#route-search")?.value.trim() || "";
  const routeFilters = routeAdmin ? routeRiderFilterValues() : null;
  let base = client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at", routeAdmin ? { count: "exact" } : undefined);
  if (routeAdmin) {
    const dateRange = routeRiderDateRange(routeFilters.period);
    if (dateRange) base = base.gte("scheduled_date", dateRange.from).lte("scheduled_date", dateRange.to);
    if (routeFilters.salesperson) base = base.eq("created_by", routeFilters.salesperson);
  }
  if (profile.role === "rider" && !routeAdmin) base = base.eq("assigned_rider", profile.id);
  else if (!routeAdmin) base = base.eq("created_by", profile.id);
  try {
    if (routeAdmin && search) {
      const term = JSON.stringify(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      base = base.or(`ref_no.ilike.${term},client_name.ilike.${term}`);
    } else if (!routeAdmin && search) base = base.ilike("client_name", `%${search}%`);
    const { data, error, count } = await base.order(routeAdmin ? "created_at" : "sr", { ascending: !routeAdmin })
      .range(riderOffset, riderOffset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data || [];
    if (token !== riderQueryToken) return;
    riderJobRows = reset ? rows : [...riderJobRows, ...rows.filter((row) => !riderJobRows.some((old) => old.id === row.id))];
    riderOffset = reset ? rows.length : riderOffset + rows.length;
    if (routeAdmin) routeRiderTotalCount = count || 0;
    if (profile.role === "rider") {
      const activeResult = await client.from("rider_jobs").select("id", { count: "exact", head: true })
        .eq("assigned_rider", profile.id).eq("status", "In progress");
      if (activeResult.error) throw activeResult.error;
      activeRiderJobCount = activeResult.count || 0;
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
      : rows.length < PAGE_SIZE);
  } catch (error) {
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
    <small data-rider-warning="${escapeHtml(row.id)}" class="warning-text"></small>
    <button type="button" class="primary" data-rider-assign="${escapeHtml(row.id)}">Assign</button></div>`;
}

async function updateRiderWarning(rowId) {
  const row = riderJobRows.find((item) => item.id === rowId);
  const rider = document.querySelector(`[data-rider-choice="${CSS.escape(rowId)}"]`)?.value;
  const slot = document.querySelector(`[data-rider-slot="${CSS.escape(rowId)}"]`);
  const selected = slot?.selectedOptions[0];
  const warning = document.querySelector(`[data-rider-warning="${CSS.escape(rowId)}"]`);
  if (!row || !rider || !selected?.value) {
    if (warning) warning.textContent = "";
    return;
  }
  const { count, error } = await client.from("rider_jobs").select("id", { count: "exact", head: true })
    .eq("assigned_rider", rider).eq("scheduled_date", row.scheduled_date)
    .eq("rider_time", selected.value).neq("status", "Finished").neq("id", rowId);
  if (error) {
    toast(error.message || "Could not check rider availability.", "error");
    return;
  }
  warning.textContent = count ? "Warning: this rider already has a job in this time slot." : "";
}

function renderRouteRiderChips(rows) {
  const chips = [
    { value: "__unassigned", label: "Pending", style: "pending" },
    ...riderUsers.map((rider) => ({ value: rider.id, label: rider.full_name, style: "ready" })),
    { value: "", label: "All", style: "all" }
  ];
  const counts = new Map(chips.map(({ value }) => [
    value,
    value === "" ? rows.length
      : value === "__unassigned" ? rows.filter((row) => !row.assigned_rider).length
        : rows.filter((row) => row.assigned_rider === value).length
  ]));
  renderStatusChipButtons(document.querySelector("#route-rider-chips"), chips, counts,
    routeRiderChipFilter, (value) => {
      routeRiderChipFilter = value;
      saveRouteRiderFilters();
      renderRiderJobs();
    }, "riderFilter");
}

function routeStatusFilterMatches(row, value) {
  if (!value) return true;
  if (value === "active") return !["Finished", "Declined"].includes(row.status);
  return row.status === value;
}

function renderRouteStatusChips(rows) {
  const counts = new Map(ROUTE_STATUS_CHIPS.map(({ value }) => [
    value,
    value ? rows.filter((row) => routeStatusFilterMatches(row, value)).length : rows.length
  ]));
  renderStatusChipButtons(document.querySelector("#route-status-chips"), ROUTE_STATUS_CHIPS, counts,
    routeStatusChipFilter, (value) => {
      routeStatusChipFilter = value;
      saveRouteRiderFilters();
      renderRiderJobs();
    }, "statusChip");
}

function renderRiderJobs() {
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
    renderRouteRiderChips(statusRows);
    renderRouteStatusChips(riderRows);
  }
  const markup = (rows, canAssign) => rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.sr)} · ${escapeHtml(row.ref_no)}</strong></td>
    ${canAssign ? `<td>${escapeHtml(requesterNames.get(row.created_by) || "Salesperson")}</td>` : ""}
    <td>${escapeHtml(row.client_name)}<br><small>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</small></td>
    <td>${escapeHtml(row.address)}<br><small>${escapeHtml(row.details)}</small></td><td>${escapeHtml(row.job_type)}</td>
    <td>${escapeHtml(riderExpectedTime(row))} · ${escapeHtml(row.scheduled_date)}</td>
    ${canAssign ? `<td>${escapeHtml(localDateTime(row.created_at))}</td>` : ""}
    <td>${canAssign ? riderAssignmentControls(row) : escapeHtml(row.assigned_rider ? riderUsers.find((user) => user.id === row.assigned_rider)?.full_name || "Assigned rider" : "Not assigned yet")}</td><td>${escapeHtml(riderSlotText(row))}</td>
    <td>${escapeHtml(row.status)}${row.decline_reason ? `<br><small>${escapeHtml(localDateTime(row.declined_at))} · ${escapeHtml(row.decline_reason)}</small>` : ""}${row.started_at ? `<br><small>Started ${escapeHtml(localDateTime(row.started_at))}</small>` : ""}${row.finished_at ? `<br><small>Finished ${escapeHtml(localDateTime(row.finished_at))}</small>` : ""}</td>
    ${canAssign ? `<td>${row.status === "Not started" ? `<button type="button" class="danger" data-rider-decline="${escapeHtml(row.id)}">Decline</button>` : "—"}</td>` : ""}</tr>`).join("");
  if (routeView) {
    const routeRows = document.querySelector("#route-rider-rows");
    routeRows.innerHTML = markup(matchingRows, true);
    initializeScrollableTables(routeRows.closest("table"));
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
    if (filters.period !== "all") {
      active.push(`Period: ${document.querySelector("#route-request-period").selectedOptions[0].textContent}`);
    }
    if (filters.salesperson) {
      active.push(`Salesperson: ${document.querySelector("#route-salesperson-filter-select").selectedOptions[0].textContent}`);
    }
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
  document.querySelector("#sales-rider-more")?.classList.toggle("hidden", !showSalesView || riderJobRows.length < PAGE_SIZE);
  const roots = [routeView ? document.querySelector("#route-rider-rows") : null,
    showSalesView ? document.querySelector("#sales-rider-rows") : null].filter(Boolean);
  roots.forEach((root) => {
    root.querySelectorAll("[data-rider-choice], [data-rider-slot]").forEach((select) => select.addEventListener("change", () => {
      void updateRiderWarning(select.dataset.riderChoice || select.dataset.riderSlot);
    }));
    root.querySelectorAll("[data-rider-assign]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.riderAssign;
      const riderId = root.querySelector(`[data-rider-choice="${CSS.escape(id)}"]`).value;
      const slotSelect = root.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`);
      const slot = slotSelect.value;
      const end = slotSelect.selectedOptions[0]?.dataset.end;
      if (!riderId || !slot || !end) {
        toast("Choose a rider and hourly slot before assigning.", "error");
        return;
      }
      await updateRiderJob(id, {
        assigned_rider: riderId, rider_time: slot, rider_time_end: end, status: "Started",
        ...(profile.role === "admin" ? { assigned_at: new Date().toISOString() } : {})
      }, button, routeView && routeRiderChipFilter === "__unassigned"
        ? "Rider assigned; removed from the unassigned list."
        : "Rider assigned.");
    }));
    root.querySelectorAll("[data-rider-decline]").forEach((button) => button.addEventListener("click", async () => {
      const reason = window.prompt("Why is this rider request being declined?");
      if (reason === null) return;
      if (!reason.trim()) {
        toast("Enter a reason before declining the request.", "error");
        return;
      }
      await updateRiderJob(button.dataset.riderDecline, {
        status: "Declined", decline_reason: reason.trim(),
        ...(profile.role === "admin" ? { declined_at: new Date().toISOString() } : {})
      }, button, "Rider request declined.");
    }));
  });
}

async function updateRiderJob(id, values, button, success) {
  setBusy(button, true);
  try {
    const { data, error } = await client.from("rider_jobs").update(values)
      .eq("id", id).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This rider job could not be updated. Refresh and try again.");
    toast(success);
    await loadRiderJobs(true);
    return true;
  } catch (error) {
    toast(error.message || "Could not update rider job.", "error");
    return false;
  } finally {
    setBusy(button, false);
  }
}

async function initRiders() {
  const requestPanel = document.querySelector("#rider-request-panel");
  const routeAdmin = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const canRequest = hasRiderRequestAccess(profile) && page === "riders.html";
  requestPanel.classList.toggle("hidden", !canRequest || page === "route-admin.html");
  document.querySelector("#route-admin-panel").classList.toggle("hidden", !routeAdmin);
  document.querySelector("#riders-list-panel").classList.toggle("hidden", !canRequest || page === "route-admin.html");
  document.querySelector("#route-riders-panel").classList.toggle("hidden", !routeAdmin);
  await loadRiderUsers();
  if (routeAdmin) {
    const { data: requesters, error: requestersError } = await client.from("profiles").select("id,full_name").eq("active", true);
    if (requestersError) throw requestersError;
    requesterNames = new Map((requesters || []).map((user) => [user.id, user.full_name]));
    document.querySelector("#route-riders-rows").innerHTML = riderUsers.map((user) =>
      `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.username)}</td><td>${user.active ? "Active" : "Inactive"}</td></tr>`
    ).join("");
    initializeScrollableTables(document.querySelector("#route-riders-rows").closest("table"));
    document.querySelector("#route-search").addEventListener("input", debounce(() => { void loadRiderJobs(true); }));
    document.querySelector("#route-more").addEventListener("click", () => { void loadRiderJobs(false); });
    await initializeRouteRiderFilters();
  }
  if (routeAdmin) {
    bindPeriodSummary("route-period", () => renderPeriodSummary("route-tallies", "route-period", "rider_jobs", [
      { label: "Received", dateColumn: "created_at" },
      { label: "Assigned", dateColumn: "assigned_at" },
      { label: "In progress", dateColumn: "started_at" },
      { label: "Finished", dateColumn: "finished_at" },
      { label: "Declined", dateColumn: "declined_at" }
    ]));
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
  startVisibleRefresh(() => loadRiderJobs(true));
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
    .sort((a, b) => `${a.scheduled_date} ${a.rider_time || ""}`.localeCompare(`${b.scheduled_date} ${b.rider_time || ""}`));
  const filtered = assigned.filter((row) => filter === "active" ? row.status !== "Finished"
    : filter === "finished" ? row.status === "Finished" : true);
  const inProgress = profile.role === "rider" ? activeRiderJobCount > 0 : assigned.some((row) => row.status === "In progress");
  root.innerHTML = filtered.map((row) => `<article class="rider-job-card" data-entry-id="${escapeHtml(row.id)}">
    <div class="rider-job-title"><div><span class="home-card-ref">${escapeHtml(row.ref_no)}</span><h2>${escapeHtml(row.client_name)}</h2></div><span class="badge ${row.status === "Finished" ? "done" : row.status === "In progress" ? "progress" : "requested"}">${escapeHtml(row.status)}</span></div>
    <dl><div><dt>Contact</dt><dd>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</dd></div>
      <div><dt>Address</dt><dd>${escapeHtml(row.address)}</dd></div><div><dt>Type / details</dt><dd>${escapeHtml(row.job_type)} · ${escapeHtml(row.details)}</dd></div>
      <div><dt>Expected</dt><dd>${escapeHtml(riderExpectedTime(row))} · ${escapeHtml(row.scheduled_date)}</dd></div>
      <div><dt>Rider time</dt><dd>${escapeHtml(riderSlotText(row))}</dd></div></dl>
    <div class="table-actions">${profile.role === "rider" && row.status === "Started" ? `<button class="primary" data-rider-start="${escapeHtml(row.id)}" ${inProgress ? "disabled" : ""}>Start</button>` : ""}
      ${profile.role === "rider" && row.status === "In progress" ? `<button class="primary" data-rider-finish="${escapeHtml(row.id)}">Finish</button>` : ""}</div></article>`).join("");
  document.querySelector("#my-jobs-empty").classList.toggle("hidden", filtered.length > 0);
  document.querySelector("#my-jobs-more")?.classList.toggle("hidden", riderJobRows.length < PAGE_SIZE);
  root.querySelectorAll("[data-rider-start]").forEach((button) => button.addEventListener("click", () =>
    updateRiderJob(button.dataset.riderStart, { status: "In progress" }, button, "Job started.")));
  root.querySelectorAll("[data-rider-finish]").forEach((button) => button.addEventListener("click", async () => {
    if (await updateRiderJob(button.dataset.riderFinish, { status: "Finished" }, button, "Job finished.")) missionOverlay();
  }));
}

async function initMyJobs() {
  bindPeriodSummary("jobs-period", () => renderPeriodSummary("jobs-tallies", "jobs-period", "rider_jobs", [
    { label: "Assigned", dateColumn: "assigned_at", filters: { assigned_rider: profile.id } },
    { label: "In progress", dateColumn: "started_at", filters: { assigned_rider: profile.id } },
    { label: "Finished", dateColumn: "finished_at", filters: { assigned_rider: profile.id } }
  ]));
  await loadRiderJobs(true);
  document.querySelector("#my-jobs-filter").addEventListener("change", renderMyJobs);
  document.querySelector("#my-jobs-more").addEventListener("click", () => { void loadRiderJobs(false); });
  client.channel(`my-rider-jobs-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "rider_jobs", filter: `assigned_rider=eq.${profile.id}`
  }, () => { void loadRiderJobs(true); }).subscribe();
  startVisibleRefresh(() => loadRiderJobs(true));
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

bootstrap();
