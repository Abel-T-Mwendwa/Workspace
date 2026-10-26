import { hasRouteAdminAccess, homePageForRole, initPortal, isPortalPageAllowed } from "./portal.js";
import { currentNairobiTime, deliverySlotLabel, deliverySlotOptions, hourlySlots } from "./delivery-slots.js";
import { bindEditorKeyboard } from "./dialog-keyboard.js";
import { riderRequestAvailability, riderRequestSlots, validateRiderRequestSlot } from "./rider-request-slots.js";

const client = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
});
const page = location.pathname.split("/").pop();
const LOGIN_AT_KEY = "loginAt";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
let session;
let profile;
let allRows = [];
let allChanges = [];
let users = [];
let deliveryRows = [];
let vehicleRows = [];
let riderJobRows = [];
let deliveryOffset = 0;
let deliveryQueryToken = 0;
let riderOffset = 0;
let riderQueryToken = 0;
let riderUsers = [];
let requesterNames = new Map();
let activeRiderJobCount = 0;
let deliveryItemsState = { initial: [], lines: [] };
let endingSession = false;
let sessionExpiryTimer = null;
const SORT_STATE_KEY = `artworkSort:${page}`;
const SORT_KEYS = ["sr", "created_month", "created_at", "ref_no", ...(page === "designer.html" ? ["date_needed"] : []), ...(page === "deliveries.html" ? ["delivery_schedule"] : [])];
function readSortState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STATE_KEY) || "null");
    return saved && SORT_KEYS.includes(saved.key) && ["asc", "desc"].includes(saved.direction) ? saved : null;
  } catch (error) {
    console.error("Could not read the table sort preference.", error);
    return null;
  }
}
const savedSortState = page === "deliveries.html" ? null : readSortState();
let activeSort = savedSortState || (page === "designer.html"
  ? { key: "date_needed", direction: "desc" }
  : page === "deliveries.html" ? { key: "delivery_schedule", direction: "asc" }
    : { key: "sr", direction: "asc" });
let userSortKey = savedSortState?.key || (page === "designer.html" ? "date_needed" : page === "deliveries.html" ? "delivery_schedule" : null);
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
      const leftDate = left.delivery_date && left.delivery_time ? Date.parse(`${left.delivery_date}T${left.delivery_time}`) : NaN;
      const rightDate = right.delivery_date && right.delivery_time ? Date.parse(`${right.delivery_date}T${right.delivery_time}`) : NaN;
      if (!Number.isFinite(leftDate)) return Number.isFinite(rightDate) ? 1 : 0;
      if (!Number.isFinite(rightDate)) return -1;
      comparison = leftDate - rightDate;
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
  const className = status === "Done" ? "done" : status === "In progress" ? "progress" : status === "Change requested" ? "change" : "requested";
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
  const { data, error } = await client.from("profiles").select("id,username,full_name,role,active,route_admin_access,created_at").order("full_name");
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
  bindSortableHeaders();
  renderSalesTallies();
  renderSales();
  document.querySelector("#sales-period").addEventListener("change", renderSalesTallies);
  document.querySelector("#sales-search").addEventListener("input", debounce(renderSales));
  document.querySelector("#sales-status").addEventListener("change", renderSales);
  document.querySelector("#new-request").addEventListener("click", () => openRequestEditor());
  document.querySelector("#change-form").addEventListener("submit", saveChange);
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
    && (!search || `${row.ref_no} ${row.client_name}`.toLowerCase().includes(search))));
  const tbody = document.querySelector("#sales-rows");
  tbody.innerHTML = rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}">
    <td>${escapeHtml(row.sr)}</td><td>${escapeHtml(row.created_month)}</td><td>${localDate(row.created_at)}</td>
    <td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(profile.full_name)}</td><td>${escapeHtml(row.client_name)}</td>
    <td>${lineFieldMarkup("product", row.product, { mode: row.status === "Requested" ? "edit" : "view", recordId: row.id, direct: row.status === "Requested" })}</td>
    <td>${brandingFieldMarkup(row.branding_details, { mode: row.status === "Requested" ? "edit" : "view", recordId: row.id, direct: row.status === "Requested" })}</td>
    <td>${localDate(row.date_needed)}</td><td>${escapeHtml(preferredDesignerName(row))}</td>
    <td>${row.status === "Done" ? `<button type="button" class="badge done done-time-trigger" data-done-time="${escapeHtml(row.completed_at || "")}" aria-expanded="false" aria-label="Done status, show completion time">Done</button> <span title="Designer marked this done">✓</span>` : statusBadge(row.status)}</td>
    <td>${row.status === "Done" && row.completed_at ? escapeHtml(localDateTime(row.completed_at)) : "—"}</td>
    <td><div class="table-actions">
      <button class="secondary" data-history="${escapeHtml(row.id)}">History</button>
      <button class="secondary" data-change="${escapeHtml(row.id)}">Change</button>
      <button class="quiet" data-edit="${escapeHtml(row.id)}" ${row.status !== "Requested" ? "disabled" : ""}>Edit</button>
    </div></td></tr>`).join("");
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
  const activeDesigners = users.filter((user) => user.role === "designer" && user.active);
  const inactivePreferred = row?.preferred_designer && !activeDesigners.some((user) => user.id === row.preferred_designer)
    ? users.find((user) => user.id === row.preferred_designer) : null;
  const designers = (inactivePreferred
    ? `<option value="${escapeHtml(inactivePreferred.id)}" selected>${escapeHtml(inactivePreferred.full_name)} (inactive)</option>` : "")
    + activeDesigners.map((user) => `<option value="${escapeHtml(user.id)}" ${row?.preferred_designer === user.id ? "selected" : ""}>${escapeHtml(user.full_name)}</option>`).join("");
  return `<form id="request-form" class="request-form"><div class="form-grid">
    <label>Category<select name="category" required><option value="">Select…</option><option ${row?.category === "New client" ? "selected" : ""}>New client</option><option ${row?.category === "Old client" ? "selected" : ""}>Old client</option></select></label>
    <label>Client name<input name="client_name" value="${escapeHtml(row?.client_name)}" required></label>
    <label>SO number<input name="so_number" value="${escapeHtml(row ? row.so_number : SO_NUMBER_PREFIX)}" required></label>
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
  protectSoNumberInput(form.elements.so_number);
  form.addEventListener("submit", (event) => saveRequest(event, row));
  container.querySelector("#discard-request").addEventListener("click", () => {
    form.elements.so_number.value = SO_NUMBER_PREFIX;
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
    if (!hasSoNumber(data.get("so_number"))) throw new Error("Enter an SO number after SO-.");
    const values = Object.fromEntries(["category","client_name","so_number","additional_info","date_needed"].map((name) => [name, data.get(name) || null]));
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
    form.elements.so_number.value = SO_NUMBER_PREFIX;
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
  bindSortableHeaders();
  renderDesignerTallies();
  document.querySelector("#designer-period").addEventListener("change", () => { void renderDesignerTallies(); });
  renderDesigner();
  document.querySelector("#designer-filter").addEventListener("change", renderDesigner);
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
  try {
    const rows = visibleDesignerRows();
    const openChanges = await changesFor(rows.map((row) => row.id));
    const assignedIds = new Set(assignmentNotifications.map((notice) => notice.artwork_id));
    const byArtwork = new Map();
    openChanges.forEach((change) => byArtwork.set(change.artwork_id, [...(byArtwork.get(change.artwork_id) || []), change]));
    const filter = document.querySelector("#designer-filter").value;
    const filtered = sortRows(rows.filter((row) => {
      if (filter === "today") return row.date_needed === today;
      if (filter === "tomorrow") return row.date_needed === tomorrow();
      if (filter === "pending") return row.status !== "Done";
      if (filter === "done") return row.status === "Done";
      if (filter === "changes") return byArtwork.has(row.id);
      if (filter === "assignments") return assignedIds.has(row.id) && row.assigned_designer === profile.id;
      return true;
    }));
    const tbody = document.querySelector("#designer-rows");
    tbody.innerHTML = filtered.map((row) => {
      const changes = byArtwork.get(row.id) || [];
      const otherDetails = [row.category, `SO ${row.so_number}`, row.additional_info].filter(Boolean).map(escapeHtml).join(" · ");
      const claimed = row.assigned_designer === profile.id && row.status === "In progress";
      const canStart = row.status !== "Done" && row.status !== "In progress"
        && (row.assigned_designer === null || row.assigned_designer === profile.id);
      return `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.ref_no)}</strong><br>${escapeHtml(row.client_name)}</td>
        <td>${localDate(row.date_needed)}</td><td><div class="designer-line-fields">${lineFieldMarkup("product", row.product, { mode: "view" })}${brandingFieldMarkup(row.branding_details, { mode: "view" })}</div>
        <p>${otherDetails}</p></td><td>${escapeHtml(profileName(row.created_by))}</td>
        <td>${statusBadge(row.status)}</td>
        <td>${changes.map((change) => `<div class="change-item">${escapeHtml(change.change_text)}<small>${escapeHtml(change.requested_by)} · ${localDate(change.requested_on)}</small></div>`).join("") || "—"}</td>
        <td><textarea data-notes="${escapeHtml(row.id)}" rows="2" placeholder="Designer notes or final file URL" ${claimed ? "" : "disabled"}>${escapeHtml(row.designer_notes)}</textarea></td>
        <td>${escapeHtml(preferredDesignerName(row))}${assignedIds.has(row.id) ? '<br><span class="badge assignment-badge">New assignment</span>' : ""}</td>
        <td><div class="table-actions">${canStart ? `<button class="primary" data-start="${escapeHtml(row.id)}">Start</button>` : ""}
        ${claimed && row.status !== "Done" ? `<button class="secondary" data-done="${escapeHtml(row.id)}">Done</button>` : ""}
        ${claimed ? `<button class="quiet" data-notes-save="${escapeHtml(row.id)}">Save notes</button>` : ""}</div></td></tr>`;
    }).join("");
    document.querySelector("#designer-empty").classList.toggle("hidden", filtered.length > 0);
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
    tbody.querySelectorAll("[data-notes-save]").forEach((button) => button.addEventListener("click", () => {
      const notes = tbody.querySelector(`[data-notes="${CSS.escape(button.dataset.notesSave)}"]`).value;
      updateArtwork(button.dataset.notesSave, { designer_notes: notes }, button, "Notes saved.");
    }));
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
  document.querySelector("#admin-edit-form").elements.preferred_designer.addEventListener("change", (event) => {
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
    && (!search || `${row.ref_no} ${row.client_name}`.toLowerCase().includes(search)));
}

function renderAdminRows() {
  const tbody = document.querySelector("#admin-rows");
  if (!tbody) return;
  const rows = sortRows(filteredAdminRows());
  tbody.innerHTML = rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(row.client_name)}<br><span class="muted">${escapeHtml(row.so_number)}</span></td>
    <td>${escapeHtml(profileName(row.created_by))}</td><td>${escapeHtml(preferredDesignerName(row))}</td><td>${escapeHtml(row.category)}</td>
    <td>${lineFieldMarkup("product", row.product, { recordId: row.id, direct: true })}</td>
    <td>${brandingFieldMarkup(row.branding_details, { recordId: row.id, direct: true })}</td>
    <td>${localDate(row.created_at)}</td><td>${localDate(row.date_needed)}</td><td>${statusBadge(row.status)}</td><td><button class="secondary" data-admin-edit="${escapeHtml(row.id)}">Edit</button></td></tr>`).join("");
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
    const { error } = await client.from("artwork_requests").update({
      category: data.get("category"), client_name: data.get("client_name"), so_number: data.get("so_number"),
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
  const columns = ["ref_no","sr","created_at","created_month","created_by","preferred_designer","assigned_designer","category","client_name","so_number","product","branding_details","high_res_logo","redesign_logo","additional_info","date_needed","status","claimed_at","done_at","done_by","designer_notes","change_count","changes_done","updated_at"];
  const brandingCsvValue = (details) => normalizeBrandingDetails(details).map((line) =>
    [["Logo", line.logo], ["Mode", line.mode], ["Pantone", line.pantone], ["Size", line.size], ["Position", line.position]]
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`)
      .join("; ")
  ).join(" | ");
  const csvValue = (row, column) => column === "preferred_designer"
    ? preferredDesignerName(row)
    : ["created_by", "assigned_designer", "done_by"].includes(column) ? profileName(row[column])
    : column === "branding_details" ? brandingCsvValue(row.branding_details)
      : lineFieldNames.includes(column) ? linesFromValue(row[column]).join(" | ") : row[column];
  const csvCell = (value) => {
    const safeValue = /^[=+\-@]/.test(String(value ?? "")) ? `'${value}` : value;
    return `"${String(safeValue ?? "").replaceAll('"', '""')}"`;
  };
  const csv = [columns.join(","), ...filteredAdminRows().map((row) => columns.map((column) => csvCell(csvValue(row, column))).join(","))].join("\r\n");
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
  const roleOptions = ["salesperson", "designer", "production", "dispatch", "route_admin", "rider", "admin"];
  document.querySelector("#user-rows").innerHTML = users.map((user) => `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.username)}</td>
    <td><select data-role="${escapeHtml(user.id)}">${roleOptions.map((role) => `<option${user.role === role ? " selected" : ""}>${role}</option>`).join("")}</select></td>
    <td><input type="checkbox" data-route-admin="${escapeHtml(user.id)}" ${user.route_admin_access || user.role === "route_admin" || user.role === "admin" ? "checked" : ""} ${user.role === "route_admin" || user.role === "admin" ? "disabled" : ""} aria-label="Route admin access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-active="${escapeHtml(user.id)}" ${user.active ? "checked" : ""} aria-label="Active"></td><td><div class="table-actions">
    <button class="secondary" data-reset="${escapeHtml(user.id)}">Reset password</button><button class="quiet" data-view-password="${escapeHtml(user.id)}">View password</button>
    ${profile?.role === "admin" ? `<button class="danger" data-delete-user="${escapeHtml(user.id)}" ${user.id === profile.id || user.role === "admin" && users.filter((entry) => entry.role === "admin").length <= 1 ? "disabled" : ""}>Delete user</button>` : ""}</div></td></tr>`).join("");
  document.querySelectorAll("[data-role]").forEach((select) => select.addEventListener("change", () => updateUser(select.dataset.role, { role: select.value }, select)));
  document.querySelectorAll("[data-route-admin]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.routeAdmin, { route_admin_access: input.checked }, input)));
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
    const { error } = await client.from("profiles").update(changes).eq("id", id);
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
  const roleOptions = ["salesperson", "designer", "production", "dispatch", "route_admin", "rider", "admin"];
  const activeCount = users.filter((user) => user.active).length;
  const inPeriod = periodBounds(document.querySelector("#users-period").value);
  document.querySelector("#user-tallies").innerHTML = tallyMarkup([
    ["Total users", users.length],
    ["Active users", activeCount],
    ["Created in period", users.filter((user) => inPeriod(user.created_at)).length],
    ...roleOptions.map((role) => [role.replace("_", " "), users.filter((user) => user.role === role).length])
  ]);
}

async function initUsers() {
  await loadUsers();
  renderUsers();
  renderUserTallies();
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
      location.replace(`./${homePageForRole()}`);
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
    if (page === "deliveries.html") await initDeliveries();
    if (page === "riders.html") await initRiders();
    if (page === "route-admin.html") await initRiders();
    if (page === "vehicles.html") await initVehicles();
    if (page === "my-jobs.html") await initMyJobs();
    const openId = new URLSearchParams(location.search).get("open");
    if (openId) {
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

const deliverySelect = "id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,items,delivery_time,delivery_date,special_instruction,production_status,dispatch_status,ready_at,dispatched_at,delivered_at,transport,vehicle_id";
const PAGE_SIZE = 20;

function deliveryItemSummary(items) {
  const lines = Array.isArray(items) ? items : [];
  if (!lines.length) return "—";
  return `${escapeHtml(lines[0].item_name)} × ${escapeHtml(lines[0].quantity)} pcs${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`;
}

function updateDeliverySlotOptions() {
  const form = document.querySelector("#delivery-request-form");
  const select = form?.elements.delivery_time;
  if (!select) return;
  const date = form.elements.delivery_date.value;
  const selected = select.value;
  const current = date === today ? currentNairobiTime() : "";
  select.innerHTML = '<option value="">Choose hourly slot</option>' + deliverySlotOptions(date, today, current).map((slot) =>
    `<option value="${slot.start}"${slot.disabled ? " disabled" : ""}>${escapeHtml(slot.label)}</option>`
  ).join("");
  if ([...select.options].some((option) => option.value === selected && !option.disabled)) select.value = selected;
}

function renderItemLineEditor() {
  const root = document.querySelector("#delivery-item-lines");
  root.replaceChildren();
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
      input.required = true;
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.shortcutRemove = "";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (deliveryItemsState.lines.length === 1) {
        deliveryItemsState.lines[0] = { so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "" };
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
    lines: (existing.length ? existing : [{ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "" }])
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
  let parsedItems;
  try {
    parsedItems = JSON.parse(payload.items || "[]");
  } catch {
    toast("Add valid item details before requesting delivery.", "error");
    return;
  }
  const items = deliveryItemsMarkup(parsedItems);
  if (!items.length || items.some((line) => !hasSoNumber(line.so_number) || !line.item_name || !line.address
    || !/^[1-9]\d*$/.test(line.quantity) || Number(line.quantity) > 99999)) {
    toast("Add complete item lines with a positive whole-number quantity.", "error");
    return;
  }
  if (!/^\+?[0-9][0-9 ()-]{6,30}$/.test(payload.contact_number.trim())) {
    toast("Enter a valid contact number.", "error");
    return;
  }
  if (payload.delivery_date < today) {
    toast("Delivery date cannot be in the past.", "error");
    return;
  }
  if (!hourlySlots().some((slot) => slot.start === payload.delivery_time)
    || payload.delivery_date === today && payload.delivery_time <= currentNairobiTime()) {
    toast("Choose an available one-hour delivery slot.", "error");
    return;
  }
  setBusy(button, true, "Requesting…");
  try {
    const { data, error } = await client.from("deliveries").insert({
      created_by: profile.id,
      client_name: payload.client_name.trim(),
      contact_name: payload.contact_name.trim(),
      contact_number: payload.contact_number.trim(),
      items,
      delivery_time: payload.delivery_time,
      delivery_date: payload.delivery_date,
      special_instruction: payload.special_instruction.trim() || null
    }).select("id,ref_no").single();
    if (error) throw error;
    toast(`Delivery request saved as ${data.ref_no}.`);
    form.reset();
    document.querySelector('[name="items"]').value = "[]";
    document.querySelector("#delivery-items-open").textContent = "Click to add item details";
    form.classList.add("hidden");
    document.querySelector("#delivery-form-toggle").textContent = "New request";
    await loadDeliveries(true);
  } catch (error) {
    toast(error.message || "Could not save the delivery request.", "error");
  } finally {
    setBusy(button, false);
  }
}

function deliveryStatusFilter(query) {
  const filter = document.querySelector("#delivery-status-filter")?.value || "";
  if (filter === "Not ready") return query.eq("production_status", "Not ready");
  if (filter === "Ready") return query.eq("production_status", "Ready").eq("dispatch_status", "Not delivered");
  if (filter === "Not delivered") return query.eq("dispatch_status", "Not delivered").not("dispatched_at", "is", null);
  if (filter === "Delivered") return query.eq("dispatch_status", "Delivered");
  return query;
}

async function queryDeliveryPage(offset, search, searchField) {
  const ascending = activeSort.direction === "asc";
  let query = deliveryStatusFilter(client.from("deliveries").select(deliverySelect));
  if (activeSort.key === "delivery_schedule") {
    query = query.order("delivery_date", { ascending, nullsFirst: false })
      .order("delivery_time", { ascending, nullsFirst: false });
  } else {
    const sortColumn = ["sr", "ref_no", "created_at"].includes(activeSort.key) ? activeSort.key : "sr";
    query = query.order(sortColumn, { ascending });
  }
  query = query.range(offset, offset + PAGE_SIZE - 1);
  if (search) query = query.ilike(searchField, `%${search}%`);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function loadDeliveries(reset = true) {
  const token = ++deliveryQueryToken;
  const previousIds = new Set(deliveryRows.map((row) => row.id));
  const wasLoaded = deliveryRows.length > 0;
  if (reset) deliveryOffset = 0;
  const search = document.querySelector("#delivery-search")?.value.trim() || "";
  try {
    const pageRows = search
      ? (await Promise.all([
        queryDeliveryPage(deliveryOffset, search, "ref_no"),
        queryDeliveryPage(deliveryOffset, search, "client_name")
      ])).flat().filter((row, index, values) => values.findIndex((other) => other.id === row.id) === index)
      : await queryDeliveryPage(deliveryOffset, "", "ref_no");
    if (token !== deliveryQueryToken) return;
    deliveryRows = reset ? pageRows : [...deliveryRows, ...pageRows.filter((row) => !deliveryRows.some((old) => old.id === row.id))];
    if (!reset) deliveryOffset += PAGE_SIZE;
    else deliveryOffset = PAGE_SIZE;
    renderDeliveryRows();
    if (wasLoaded) {
      document.querySelectorAll("#delivery-rows [data-entry-id]").forEach((row) => {
        if (!previousIds.has(row.dataset.entryId)) row.classList.add("portal-new-row");
      });
    }
    document.querySelector("#delivery-more").classList.toggle("hidden", pageRows.length < PAGE_SIZE);
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
  const filtered = sortRows(deliveryRows.filter((row) => !query
    || `${row.ref_no} ${row.client_name} ${row.contact_name}`.toLowerCase().includes(query)));
  tbody.innerHTML = filtered.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}">
    <td>${escapeHtml(row.sr)}</td><td>${escapeHtml(row.delivery_date)}${row.delivery_time ? `<br>${escapeHtml(deliverySlotLabel(row.delivery_time))}` : ""}</td>
    <td><strong>${escapeHtml(row.ref_no)}</strong></td><td>${escapeHtml(localDateTime(row.created_at))}</td>
    <td>${escapeHtml(row.client_name)}<br><span class="muted">${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</span></td>
    <td class="delivery-items-cell" data-delivery-items="${escapeHtml(row.id)}" role="button" tabindex="0" aria-label="View items">${deliveryItemSummary(row.items)}</td>
    <td><span class="${row.production_status === "Ready" ? "delivery-status-green" : "delivery-status-red"}">${escapeHtml(row.production_status)}</span>${row.ready_at ? `<br><small>${escapeHtml(localDateTime(row.ready_at))}</small>` : ""}</td>
    <td><span class="delivery-status-${row.dispatch_status === "Delivered" ? "green" : "orange"}">${row.dispatch_status === "Delivered" ? "Delivered" : row.dispatched_at ? "Not delivered" : "Not packed"}</span>${row.dispatched_at ? `<br><small>Packed ${escapeHtml(localDateTime(row.dispatched_at))}</small>` : ""}</td>
    <td><div class="delivery-table-actions">${["admin", "production", "dispatch", "salesperson"].includes(profile.role) ? `<button type="button" class="secondary" data-delivery-view="${escapeHtml(row.id)}">View</button>` : ""}${deliveryActions(row)}</div></td></tr>`).join("");
  dispatchValues.forEach((values, id) => {
    const transport = tbody.querySelector(`[data-transport="${CSS.escape(id)}"]`);
    const vehicle = tbody.querySelector(`[data-vehicle="${CSS.escape(id)}"]`);
    if (transport) {
      transport.value = values.transport;
      vehicle?.classList.toggle("hidden", values.transport !== "Company");
    }
    if (vehicle && [...vehicle.options].some((option) => option.value === values.vehicle)) vehicle.value = values.vehicle;
  });
  document.querySelector("#delivery-empty").classList.toggle("hidden", filtered.length > 0);
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

function openDeliveryItemsView(row, trigger) {
  const items = Array.isArray(row.items) ? row.items : [];
  const content = document.querySelector("#delivery-items-view-content");
  content.innerHTML = `<table><thead><tr><th>SO number</th><th>Item name</th><th>Quantity (pcs)</th><th>Address to deliver</th></tr></thead><tbody>${items.map((item) =>
    `<tr><td>${escapeHtml(item.so_number)}</td><td>${escapeHtml(item.item_name)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(item.address)}</td></tr>`
  ).join("")}</tbody></table>`;
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
    .eq("id", row.created_by).maybeSingle();
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
  const content = document.querySelector("#delivery-view-content");
  content.innerHTML = `<dl class="delivery-detail-grid">
    <div><dt>Reference number</dt><dd>${escapeHtml(row.ref_no)}</dd></div>
    <div><dt>Requested by</dt><dd>${escapeHtml(requestedBy)}</dd></div>
    <div><dt>Time requested</dt><dd>${escapeHtml(localDateTime(row.created_at))}</dd></div>
    <div><dt>Client</dt><dd>${escapeHtml(row.client_name)}</dd></div>
    <div><dt>Contact name</dt><dd>${escapeHtml(row.contact_name)}</dd></div>
    <div><dt>Contact number</dt><dd>${escapeHtml(row.contact_number)}</dd></div>
    <div><dt>Delivery date and time</dt><dd>${escapeHtml(row.delivery_date)} · ${escapeHtml(deliverySlotLabel(row.delivery_time))}</dd></div>
    <div><dt>Special instruction</dt><dd>${escapeHtml(row.special_instruction || "—")}</dd></div>
  </dl>
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

async function initDeliveries() {
  const requestPanel = document.querySelector("#delivery-request-panel");
  if (profile.role !== "salesperson" && profile.role !== "admin") requestPanel.classList.add("hidden");
  else {
    const form = document.querySelector("#delivery-request-form");
    form.elements.delivery_date.min = today;
    updateDeliverySlotOptions();
    form.elements.delivery_date.addEventListener("change", updateDeliverySlotOptions);
    document.querySelector("#delivery-form-toggle").addEventListener("click", () => {
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
    document.querySelector("#delivery-items-open").addEventListener("click", openDeliveryItems);
  }
  if (profile.role === "dispatch" || profile.role === "admin") await loadActiveVehicles();
  document.querySelector("#delivery-search").addEventListener("input", debounce(() => { void loadDeliveries(true); }));
  document.querySelector("#delivery-status-filter").addEventListener("change", () => { void loadDeliveries(true); });
  document.querySelector("#delivery-more").addEventListener("click", () => { void loadDeliveries(false); });
  document.querySelector("#delivery-item-add").addEventListener("click", () => {
    deliveryItemsState.lines.push({ so_number: SO_NUMBER_PREFIX, item_name: "", quantity: "", address: "" });
    renderItemLineEditor();
    document.querySelector("#delivery-item-lines").lastElementChild?.querySelector("input")?.focus();
  });
  document.querySelector("#delivery-item-save").addEventListener("click", () => {
    const lines = deliveryItemsMarkup(deliveryItemsState.lines);
    clearDeliveryItemErrors();
    let firstInvalid = null;
    lines.forEach((line, index) => {
      const row = document.querySelectorAll("#delivery-item-lines .delivery-item-row")[index];
      const invalidFields = [
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
      `${line.item_name} × ${line.quantity} pcs`).join(" · ");
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
  bindPeriodSummary("delivery-period", () => renderPeriodSummary("delivery-tallies", "delivery-period", "deliveries", deliveryCards));
  await loadDeliveries(true);
  client.channel(`deliveries-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "deliveries"
  }, () => { void loadDeliveries(true); }).subscribe();
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
    if (profile.role === "dispatch" || profile.role === "admin") {
      await loadActiveVehicles();
      renderDeliveryRows();
    }
  });
  const openId = new URLSearchParams(location.search).get("open");
  if (openId && !deliveryRows.some((row) => row.id === openId)) {
    const { data, error } = await client.from("deliveries").select(deliverySelect).eq("id", openId).maybeSingle();
    if (error) throw error;
    if (data) {
      deliveryRows.push(data);
      renderDeliveryRows();
    }
  }
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
  if (!/^\+?[0-9][0-9 ()-]{6,30}$/.test(values.contact_number.trim())) {
    toast("Enter a valid contact number.", "error");
    return;
  }
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
      expected_time: values.expected_time,
      scheduled_date: values.scheduled_date
    }).select("id,ref_no").single();
    if (error) throw error;
    toast(`Rider request saved as ${data.ref_no}.`);
    form.reset();
    initializeRiderRequestDate(form);
    await loadRiderJobs(true);
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
  timeSelect.innerHTML = '<option value="">Choose expected time</option>'
    + riderRequestSlots().map((slot) => {
      const endHour = Number(slot.value.slice(0, 2)) + 1;
      const endLabel = `${endHour % 12 || 12}:00 ${endHour < 12 ? "AM" : "PM"}`;
      return `<option value="${slot.value}"${available.has(slot.value) ? "" : " disabled"}>${slot.label} - ${endLabel}${available.has(slot.value) ? "" : " - unavailable"}</option>`;
    }).join("");
  timeSelect.value = available.has(previousTime) ? previousTime : "";
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

async function loadRiderJobs(reset = true) {
  const token = ++riderQueryToken;
  const previousIds = new Set(riderJobRows.map((row) => row.id));
  const wasLoaded = riderJobRows.length > 0;
  if (reset) riderOffset = 0;
  const routeAdmin = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const search = document.querySelector("#route-search")?.value.trim() || "";
  const status = document.querySelector("#route-status-filter")?.value || "";
  let base = client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at");
  if (routeAdmin && status) base = base.eq("status", status);
  if (profile.role === "rider" && !routeAdmin) base = base.eq("assigned_rider", profile.id);
  else if (!routeAdmin) base = base.eq("created_by", profile.id);
  const searchQuery = (field) => {
    let query = client.from("rider_jobs").select("id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,job_type,details,expected_time,scheduled_date,assigned_rider,rider_time,rider_time_end,status,decline_reason,declined_at,assigned_at,started_at,finished_at");
    if (routeAdmin && status) query = query.eq("status", status);
    if (profile.role === "rider" && !routeAdmin) query = query.eq("assigned_rider", profile.id);
    else if (!routeAdmin) query = query.eq("created_by", profile.id);
    return query.ilike(field, `%${search}%`).order(routeAdmin ? "created_at" : "sr", { ascending: !routeAdmin })
      .range(riderOffset, riderOffset + PAGE_SIZE - 1);
  };
  try {
    let rows;
    if (routeAdmin && search) {
      const results = await Promise.all([searchQuery("ref_no"), searchQuery("client_name")]);
      const error = results.find((result) => result.error)?.error;
      if (error) throw error;
      rows = results.flatMap((result) => result.data || [])
        .filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, PAGE_SIZE);
    } else {
      if (!routeAdmin && search) base = base.ilike("client_name", `%${search}%`);
      const { data, error } = await base.order(routeAdmin ? "created_at" : "sr", { ascending: !routeAdmin }).range(riderOffset, riderOffset + PAGE_SIZE - 1);
      if (error) throw error;
      rows = data || [];
    }
    if (token !== riderQueryToken) return;
    riderJobRows = reset ? rows : [...riderJobRows, ...rows.filter((row) => !riderJobRows.some((old) => old.id === row.id))];
    riderOffset = reset ? PAGE_SIZE : riderOffset + PAGE_SIZE;
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
    document.querySelector("#route-more")?.classList.toggle("hidden", rows.length < PAGE_SIZE);
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

function renderRiderJobs() {
  const routeView = hasRouteAdminAccess(profile) && page === "route-admin.html";
  const showSalesView = profile.role === "salesperson" && page === "riders.html";
  const assignmentValues = new Map([...(document.querySelector("#route-rider-rows")?.querySelectorAll("[data-rider-choice]") || [])]
    .map((select) => {
      const id = select.dataset.riderChoice;
      return [id, {
        rider: select.value,
        slot: document.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`)?.value || ""
      }];
    }));
  const search = document.querySelector("#route-search")?.value.trim().toLowerCase() || "";
  const status = routeView ? document.querySelector("#route-status-filter")?.value || ""
    : document.querySelector("#sales-rider-filter")?.value || "";
  const matchingRows = riderJobRows.filter((row) => (!search || `${row.ref_no} ${row.client_name}${routeView ? "" : ` ${row.address}`}`.toLowerCase().includes(search))
    && (!status || row.status === status));
  const markup = (rows, canAssign) => rows.map((row) => `<tr data-entry-id="${escapeHtml(row.id)}"><td><strong>${escapeHtml(row.sr)} · ${escapeHtml(row.ref_no)}</strong></td>
    ${canAssign ? `<td>${escapeHtml(requesterNames.get(row.created_by) || "Salesperson")}</td>` : ""}
    <td>${escapeHtml(row.client_name)}<br><small>${escapeHtml(row.contact_name)} · ${escapeHtml(row.contact_number)}</small></td>
    <td>${escapeHtml(row.address)}<br><small>${escapeHtml(row.details)}</small></td><td>${escapeHtml(row.job_type)}</td>
    <td>${escapeHtml(row.expected_time?.slice(0, 5))} · ${escapeHtml(row.scheduled_date)}</td>
    ${canAssign ? `<td>${escapeHtml(localDateTime(row.created_at))}</td>` : ""}
    <td>${canAssign ? riderAssignmentControls(row) : escapeHtml(row.assigned_rider ? riderUsers.find((user) => user.id === row.assigned_rider)?.full_name || "Assigned rider" : "Not assigned yet")}</td><td>${escapeHtml(riderSlotText(row))}</td>
    <td>${escapeHtml(row.status)}${row.decline_reason ? `<br><small>${escapeHtml(localDateTime(row.declined_at))} · ${escapeHtml(row.decline_reason)}</small>` : ""}${row.started_at ? `<br><small>Started ${escapeHtml(localDateTime(row.started_at))}</small>` : ""}${row.finished_at ? `<br><small>Finished ${escapeHtml(localDateTime(row.finished_at))}</small>` : ""}</td>
    ${canAssign ? `<td>${row.status === "Not started" ? `<button type="button" class="danger" data-rider-decline="${escapeHtml(row.id)}">Decline</button>` : "—"}</td>` : ""}</tr>`).join("");
  if (routeView) {
    const routeRows = document.querySelector("#route-rider-rows");
    routeRows.innerHTML = markup(matchingRows, true);
    assignmentValues.forEach((values, id) => {
      const rider = routeRows.querySelector(`[data-rider-choice="${CSS.escape(id)}"]`);
      const slot = routeRows.querySelector(`[data-rider-slot="${CSS.escape(id)}"]`);
      if (rider) rider.value = values.rider;
      if (slot) slot.value = values.slot;
    });
    document.querySelector("#route-rider-empty")?.classList.toggle("hidden", matchingRows.length > 0);
  }
  if (showSalesView) {
    const salesRows = matchingRows.filter((row) => row.created_by === profile.id);
    const salesRoot = document.querySelector("#sales-rider-rows");
    salesRoot.innerHTML = markup(salesRows, false);
    document.querySelector("#sales-rider-empty")?.classList.toggle("hidden", salesRows.length > 0);
  }
  const loadMore = document.querySelector("#route-more");
  if (loadMore) loadMore.classList.toggle("hidden", !routeView || riderJobRows.length < PAGE_SIZE);
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
      }, button, "Rider assigned.");
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
  const canRequest = profile.role === "salesperson" && page === "riders.html";
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
    document.querySelector("#route-search").addEventListener("input", debounce(() => { void loadRiderJobs(true); }));
    document.querySelector("#route-status-filter").addEventListener("change", () => { void loadRiderJobs(true); });
    document.querySelector("#route-more").addEventListener("click", () => { void loadRiderJobs(false); });
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
      <div><dt>Expected</dt><dd>${escapeHtml(row.expected_time?.slice(0, 5))} · ${escapeHtml(row.scheduled_date)}</dd></div>
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
