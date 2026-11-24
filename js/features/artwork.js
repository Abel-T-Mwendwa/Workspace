import { client } from "../core/supabase-client.js";
import { startVisibleRefresh } from "../core/visible-refresh.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { initializeScrollableTables } from "../ui/scrollable-table.js";
import { sortRows, updateSortIndicators, bindSortableHeaders } from "../ui/table-sort.js";
import { escapeHtml } from "../utils/escape-html.js";
import { debounce } from "../utils/debounce.js";
import { dateKey, localDate, localDateTime, periodBounds, today } from "../utils/dates.js";
import { linesFromValue, lineFieldNames, lineFieldTitles } from "../utils/lines.js";
import { normalizeBrandingDetails } from "../utils/branding.js";
import { lineFieldMarkup, initLineDialog } from "./line-dialog.js";
import { brandingFieldMarkup, initBrandingDialog } from "./branding-dialog.js";
import { tallyMarkup } from "./activity-panel.js";
import { fetchProfiles } from "../services/users.service.js";

let profile;
let page;
let users = [];
let allRows = [];
let allChanges = [];
let designerOpenArtworkIds = new Set();
let allWorkNotes = [];
let workNotesByRequest = new Map();
let activeWorkNoteRequestId = null;
let artworkRealtimeTimer = null;
let artworkRefreshInFlight = false;
let artworkRefreshQueued = false;
let designerChangeTrigger = null;
let designerBodyOverflow = "";
let designerRenderToken = 0;
let donePopoverTrigger = null;
let assignmentNotifications = [];
const SO_REFERENCE_PLACEHOLDER = "SO-N/A";
let artworkDialogsInitialized = false;

async function loadUsers() {
  users = await fetchProfiles();
  return users;
}

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

function initArtworkDialogs() {
  if (artworkDialogsInitialized) return;
  artworkDialogsInitialized = true;
  initLineDialog({ saveLines, onSaved });
  initBrandingDialog({ saveBranding, onSaved });
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


export async function initSales({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  initArtworkDialogs();
  document.querySelector("#current-user").textContent = profile.full_name;
  await Promise.all([loadArtworks(), loadUsers()]);
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


export function renderSales() {
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


export function closeDonePopover() {
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


export async function initDesigner({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  initArtworkDialogs();
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


export async function renderDesigner() {
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


export async function initAdmin({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  initArtworkDialogs();
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


export function renderAdminRows() {
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


export function cancelArtworkRefresh() {
  window.clearTimeout(artworkRealtimeTimer);
}
