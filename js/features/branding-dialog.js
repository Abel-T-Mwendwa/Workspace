import { escapeHtml } from "../utils/escape-html.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { brandingModes, normalizeBrandingDetails, brandingSummary } from "../utils/branding.js";
import { bindEditorKeyboard } from "../dialog-keyboard.js";

let brandingDialog;
let brandingDialogState;
let brandingDialogDependencies;

export function brandingFieldMarkup(value, { mode = "edit", recordId = "", direct = false } = {}) {
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
      await brandingDialogDependencies.saveBranding(state.recordId, nonEmpty);
      brandingDialogDependencies.onSaved(state.recordId, "branding_details", nonEmpty);
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

export function initBrandingDialog({ saveBranding, onSaved }) {
  brandingDialogDependencies = { saveBranding, onSaved };
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-branding-field]");
    if (trigger) openBrandingDialog(trigger);
  });
  makeBrandingDialog();
}
