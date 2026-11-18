import { client } from "../core/supabase-client.js";
import { toast } from "../ui/toast.js";
import { escapeHtml } from "../utils/escape-html.js";
import { debounce } from "../utils/debounce.js";
import { canSeeStatusBoard, homePageForRole } from "../portal.js";
import {
  deliverySoNumbers, deliveryAddressUrgent, deliveryGoodsStatusLabel, deliveryGoodsStatus,
  deliveryProductionStatusMarkup, deliveryDispatchStatusMarkup
} from "../utils/delivery-rows.js";

let profile;
let page;

const STATUS_BOARD_REFRESH_MS = 3 * 60 * 1000;
const STATUS_BOARD_PROFILES_TTL_MS = 10 * 60 * 1000;
const STATUS_COLOURS = {
  ready: "green",
  partial: "orange",
  not_ready: "red",
  requested: "blue",
  pending: "grey",
  queued: "grey",
  Pending: "grey",
  "Not ready": "red",
  "Partially ready": "orange",
  Ready: "green",
  "In production": "blue",
  "In progress": "blue",
  Packed: "blue",
  "Not packed": "orange",
  "Not delivered": "blue",
  "On route": "teal",
  Delivered: "green",
  "On hold": "orange",
  Queued: "grey",
  Requested: "purple",
  "Change requested": "orange",
  Done: "green",
  "Not started": "grey",
  Started: "blue",
  Finished: "green",
  Declined: "red"
};
const STATUS_BOARD_STAGES = [
  ["production_store", "PRODUCTION STORE"],
  ["production", "PRODUCTION"],
  ["dispatch", "DISPATCH"],
  ["delivered", "DELIVERED"]
];
let statusBoardRows = [];
let statusBoardProfiles = new Map();
let statusBoardArtworkRows = [];
let statusBoardRiderRows = [];
let statusBoardPreviousColumns = new Map();
let statusBoardLoadedWorkflows = new Set();
let statusBoardMovedKeys = new Set();
let statusBoardMovedTimers = new Map();
let statusBoardLiveChannels = [];
let statusBoardChannelStates = new Map();
let statusBoardRealtimeTimer = null;
let statusBoardRefreshQueued = false;
let statusBoardProfilesLoadedAt = 0;
let statusBoardLastRefreshAt = 0;
let statusBoardReportedQueryErrors = new Set();
let statusBoardWorkflowFilters = {
  artworks: { search: "", person: "", date: "all" },
  riders: { search: "", person: "", date: "all" }
};
let statusBoardTableDialogView = null;
let statusBoardTableFilter = "all";
let statusBoardSummaryFilter = "all";
const STATUS_BOARD_WORKFLOW_CONFIG = {
  artworks: {
    panelId: "status-panel-artworks",
    table: "artwork_requests",
    personLabel: "Salesperson",
    personId: (row) => row.created_by,
    columns: [
      { key: "Requested", title: "Requested", closed: false, date: (row) => row.created_at },
      { key: "In progress", title: "In progress", closed: false, date: (row) => row.created_at },
      { key: "Change requested", title: "Change requested", closed: false, date: (row) => row.created_at },
      { key: "Done", title: "Done", closed: true, date: (row) => row.done_at || row.date_needed }
    ]
  },
  riders: {
    panelId: "status-panel-riders",
    table: "rider_jobs",
    personLabel: "Rider",
    personId: (row) => row.assigned_rider,
    columns: [
      { key: "Awaiting rider", title: "Awaiting rider", closed: false, date: (row) => row.created_at },
      { key: "Assigned", title: "Assigned", closed: false, date: (row) => row.created_at },
      { key: "Started", title: "Started", closed: false, date: (row) => row.started_at || row.created_at },
      { key: "In progress", title: "In progress", closed: false, date: (row) => row.started_at || row.created_at },
      { key: "Finished", title: "Finished", closed: true, date: (row) => row.finished_at || row.scheduled_date },
      { key: "Declined", title: "Declined", closed: true, date: (row) => row.declined_at || row.scheduled_date }
    ]
  }
};
let statusBoardSelectedStage = "all";
let statusBoardRefreshTimer = null;
let statusBoardLoading = false;
let statusBoardUnknownStatuses = new Set();
let statusBoardReportedIssues = new Set();

function statusBoardStageOf(row) {
  if (row.delivered_at || row.dispatch_status === "Delivered") return "delivered";
  if (row.production_status === "Ready" || row.dispatched_at) return "dispatch";
  if (["ready", "partial"].includes(row.goods_status)) return "production";
  if (!row.goods_status || row.goods_status === "not_ready") return "production_store";
  return "production";
}

function statusBoardDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;
}

function statusBoardToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function statusBoardDueState(value, closed = false) {
  if (closed) return "";
  const date = statusBoardDate(value);
  if (!date) return "";
  const todayValue = statusBoardToday();
  if (date < todayValue) return "overdue";
  if (date === todayValue) return "today";
  return "";
}

function statusBoardDueBadge(value, closed = false) {
  const state = statusBoardDueState(value, closed);
  return state === "overdue"
    ? '<span class="status-board-due-overdue">Overdue</span>'
    : state === "today" ? '<span class="status-board-due-today">Due today</span>' : "";
}

function statusBoardDateLabel(value) {
  const date = statusBoardDate(value);
  if (!date) return "—";
  const parsed = new Date(`${date}T00:00:00+03:00`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Nairobi"
  }).format(parsed);
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

function statusBoardCardStatusMarkup(row, stage) {
  if (stage === "production_store") {
    const status = deliveryGoodsStatus(row);
    if (!status) return "—";
    const colour = status === "ready" ? "green" : status === "partial" ? "orange" : "red";
    const label = status === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(status);
    return `<span class="goods-status-pill delivery-status-${colour}">${escapeHtml(label)}</span>`;
  }
  if (stage === "production") return deliveryProductionStatusMarkup(row, "—", false);
  return deliveryDispatchStatusMarkup(row, "—", false);
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
  const rows = STATUS_BOARD_STAGES.flatMap(([stage]) => stages[stage]);
  const overdueCount = rows.filter((row) =>
    statusBoardStageOf(row) !== "delivered" && statusBoardDueState(row.delivery_date) === "overdue").length;
  const summary = [
    ["all", "All", rows.length, "blue"],
    ["overdue", "Overdue", overdueCount, "red"],
    ["delivered", "Delivered", stages.delivered.length, "green"]
  ];
  const summaryRoot = document.querySelector("#status-board-summary");
  const stageTabs = document.querySelector("#status-board-stage-tabs");
  summaryRoot.innerHTML = summary.map(([label, count, colour]) =>
    `<article class="status-board-summary-card status-board-summary-${colour}" data-summary-filter="${label}" role="button" tabindex="0" aria-pressed="${statusBoardSummaryFilter === label}"><span>${escapeHtml(label === "all" ? "All" : label === "overdue" ? "Overdue" : "Delivered")}</span><strong>${count}</strong></article>`
  ).join("");
  summaryRoot.append(stageTabs);
  summaryRoot.querySelectorAll("[data-summary-filter]").forEach((button) => {
    const activate = () => {
      statusBoardSummaryFilter = statusBoardSummaryFilter === button.dataset.summaryFilter
        ? "all" : button.dataset.summaryFilter;
      statusBoardRender();
    };
    button.addEventListener("click", activate);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  const from = document.querySelector("#status-board-date-from").value || "any date";
  const to = document.querySelector("#status-board-date-to").value || "any date";
  document.querySelector("#status-board-date-count").textContent = `${stages.delivered.length} delivered between ${from} and ${to}`;
}

function statusBoardApplySummaryFilter(view) {
  const visibleRows = view.visibleRows.filter((row) => {
    if (statusBoardSummaryFilter === "delivered") return statusBoardStageOf(row) === "delivered";
    if (statusBoardSummaryFilter === "overdue") {
      return statusBoardStageOf(row) !== "delivered"
        && statusBoardDueState(row.delivery_date) === "overdue";
    }
    return true;
  });
  const stages = Object.fromEntries(STATUS_BOARD_STAGES.map(([key]) => [key, []]));
  const statusCounts = Object.fromEntries(STATUS_BOARD_STAGES.map(([key]) => [key, new Map()]));
  visibleRows.forEach((row) => {
    const stage = statusBoardStageOf(row);
    stages[stage].push(row);
    const label = statusBoardDisplayStatus(row, stage);
    if (label !== "—") statusCounts[stage].set(label, (statusCounts[stage].get(label) || 0) + 1);
  });
  return { stages, statusCounts, visibleRows };
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
    button.setAttribute("aria-controls", "status-board-table-dialog");
    button.setAttribute("aria-haspopup", "dialog");
    const selected = statusBoardTableDialogView === key;
    button.setAttribute("aria-pressed", String(selected));
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
      statusBoardTableDialogView = key;
      statusBoardTableFilter = "all";
      statusBoardRender();
      document.querySelector("#status-board-table-dialog").showModal();
      statusBoardRenderTableDialog();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.querySelectorAll(".status-board-stage-tab")];
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
  const statusMarkup = statusBoardCardStatusMarkup(row, stage);
  const soNumbers = deliverySoNumbers(row);
  const salesperson = statusBoardProfiles.get(row.salesperson_id || row.created_by) || "—";
  const href = stage === "production_store" ? "./production-store.html" : "./deliveries.html";
  const items = statusBoardFullItems(row);
  const urgent = deliveryAddressUrgent(row);
  const boardKey = `delivery:${row.id}`;
  const moved = statusBoardMovedKeys.has(boardKey) ? " status-board-card-moved" : "";
  const dueBadge = statusBoardDueBadge(row.delivery_date, stage === "delivered");
  return `<a class="status-board-card status-board-card-${colour}${moved}" data-board-key="${escapeHtml(boardKey)}" href="${href}?open=${escapeHtml(encodeURIComponent(row.id))}" aria-label="SR ${escapeHtml(row.sr)}, ${escapeHtml(row.ref_no)}, ${escapeHtml(status)}">
    <div class="status-board-card-heading"><strong>${escapeHtml(soNumbers.join(", ") || "—")}</strong></div>
    <div class="status-board-card-status">${statusMarkup}</div>
    ${row.client_name?.trim() ? `<div class="status-board-card-client">${escapeHtml(row.client_name)}</div>` : ""}
    <div class="status-board-card-meta">${escapeHtml(salesperson)} · ${escapeHtml(row.ref_no || "—")}</div>
    <div class="status-board-card-meta">Delivery ${escapeHtml(statusBoardDateLabel(row.delivery_date))}</div>
    ${dueBadge ? `<div class="status-board-card-badges">${dueBadge}</div>` : ""}
    ${urgent ? '<div class="status-board-address-urgent">URGENT: address missing</div>' : ""}
    <div class="status-board-card-items" title="${escapeHtml(items)}">${escapeHtml(items)}</div>
  </a>`;
}

function statusBoardRenderKanban(stages, statusCounts, selectedStage = "all") {
  const root = document.querySelector("#status-board-kanban");
  const visibleStages = selectedStage === "all"
    ? STATUS_BOARD_STAGES
    : STATUS_BOARD_STAGES.filter(([stage]) => stage === selectedStage);
  root.dataset.cols = String(visibleStages.length);
  root.style.setProperty("--board-cols", String(visibleStages.length));
  root.innerHTML = visibleStages.map(([stage, label]) => {
    const stageRows = statusBoardSort(stages[stage], stage);
    const counts = statusCounts[stage];
    const overdueCount = stageRows.filter((row) =>
      statusBoardDueState(row.delivery_date, stage === "delivered") === "overdue").length;
    return `<section class="status-board-column status-board-column-${stage}" data-stage="${stage}"><header><h2>${escapeHtml(label)} <span class="status-board-column-count">${stageRows.length}</span></h2><p>${overdueCount} overdue · ${escapeHtml(statusBoardStatusCounts(counts))}</p></header>
      <div class="status-board-column-cards">${stageRows.length
        ? stageRows.map((row) => statusBoardCard(row, stage)).join("")
        : `<p class="status-board-nothing">${stage === "delivered" ? "No deliveries in this date range" : "Nothing here"}</p>`}</div></section>`;
  }).join("");
}

function statusBoardDispatchStatus(row) {
  return row.dispatch_status === "Delivered" ? "Delivered" : row.dispatched_at ? "Not delivered" : "Not packed";
}

function statusBoardTableRows(stages, view) {
  const stageKeys = view === "all"
    ? STATUS_BOARD_STAGES.map(([key]) => key)
    : view === "delivered"
      ? ["delivered"]
      : STATUS_BOARD_STAGES.some(([key]) => key === view)
        ? [view]
        : [];
  return stageKeys.flatMap((key) => statusBoardSort(stages[key], key)
    .map((row) => ({ row, stage: key })));
}

function statusBoardTableRowMarkup(row) {
  const goodsStatus = deliveryGoodsStatus(row);
  const goodsColour = goodsStatus === "ready" ? "green" : goodsStatus === "partial" ? "orange" : "red";
  const goodsLabel = goodsStatus === "partial" ? "Partially ready" : deliveryGoodsStatusLabel(goodsStatus);
  const goodsMarkup = goodsStatus
    ? `<span class="goods-status-pill delivery-status-${goodsColour}">${escapeHtml(goodsLabel)}</span>`
    : "—";
  return `<tr>
    <td>${escapeHtml(deliverySoNumbers(row).join(", ") || "—")}</td>
    <td>${escapeHtml(statusBoardProfiles.get(row.salesperson_id || row.created_by) || "—")}</td>
    <td>${escapeHtml(row.client_name || "—")}</td>
    <td>${escapeHtml(statusBoardFullItems(row))}</td>
    <td>${goodsMarkup}</td>
    <td>${deliveryProductionStatusMarkup(row)}</td>
    <td>${deliveryDispatchStatusMarkup(row)}</td>
  </tr>`;
}

function statusBoardTableFilterMatches(item, filter) {
  const delivered = item.stage === "delivered" || statusBoardDispatchStatus(item.row) === "Delivered";
  if (filter === "not-delivered") return !delivered;
  if (filter === "overdue") {
    return !delivered && statusBoardDueState(item.row.delivery_date) === "overdue";
  }
  return true;
}

function statusBoardRenderTableDialog() {
  const dialog = document.querySelector("#status-board-table-dialog");
  if (!dialog.open || !statusBoardTableDialogView) return;
  const wrap = document.querySelector("#status-board-table-wrap");
  const scrollTop = wrap.scrollTop;
  const scrollLeft = wrap.scrollLeft;
  const stages = statusBoardApplySummaryFilter(statusBoardBuildView()).stages;
  const rows = statusBoardTableRows(stages, statusBoardTableDialogView);
  const filterOptions = [
    ["all", "All"],
    ["not-delivered", "Not delivered"],
    ["overdue", "Overdue"]
  ];
  const titleLabel = statusBoardTableDialogView === "all"
    ? "All stages"
    : STATUS_BOARD_STAGES.find(([key]) => key === statusBoardTableDialogView)?.[1] || "All stages";
  const filterLabel = filterOptions.find(([value]) => value === statusBoardTableFilter)?.[1] || "All";
  const visibleRows = rows.filter((item) => statusBoardTableFilterMatches(item, statusBoardTableFilter));
  const counts = filterOptions.map(([value, label]) => [
    value,
    label,
    rows.filter((item) => statusBoardTableFilterMatches(item, value)).length
  ]);
  const filterRoot = document.querySelector("#status-board-table-filters");
  filterRoot.replaceChildren(...counts.map(([value, label, count]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "status-board-stage-tab status-board-table-filter";
    button.textContent = `${label} ${count}`;
    button.setAttribute("aria-pressed", String(statusBoardTableFilter === value));
    button.addEventListener("click", () => {
      statusBoardTableFilter = value;
      statusBoardRenderTableDialog();
    });
    return button;
  }));
  const search = document.querySelector("#status-board-search").value.trim();
  const selectedPerson = document.querySelector("#status-board-salesperson");
  const salesperson = selectedPerson.selectedOptions[0]?.textContent || "All salespeople";
  const from = document.querySelector("#status-board-date-from").value || "Any";
  const to = document.querySelector("#status-board-date-to").value || "Any";
  const filterDescription = [
    `Search: ${search || "None"}`,
    `Salesperson: ${salesperson}`,
    `Delivered date: ${from} – ${to}`
  ].join(" · ");
  document.querySelector("#status-board-table-dialog-heading").textContent = `${titleLabel} table`;
  document.querySelector("#status-board-table-title").textContent =
    statusBoardTableFilter === "all" ? titleLabel : `${titleLabel} — ${filterLabel}`;
  document.querySelector("#status-board-table-range").textContent = filterDescription;
  document.querySelector("#status-board-table-total").textContent = `Total: ${visibleRows.length}`;
  document.querySelector("#status-board-table-printed").textContent =
    `Printed on ${statusBoardFormatDateTime(new Date())}`;
  const body = document.querySelector("#status-board-table-body");
  body.innerHTML = visibleRows.map(({ row }) => statusBoardTableRowMarkup(row)).join("");
  const empty = document.querySelector("#status-board-table-empty");
  empty.textContent = "Nothing here";
  empty.classList.toggle("hidden", visibleRows.length > 0);
  wrap.scrollTop = scrollTop;
  wrap.scrollLeft = scrollLeft;
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
    const colour = done ? "green" : isCurrent ? statusBoardRecordColour(row, stage) : "grey";
    const whoId = stage === "production_store" ? row.created_by : null;
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
  const baseView = statusBoardBuildView();
  const { stages, statusCounts, visibleRows } = statusBoardApplySummaryFilter(baseView);
  const phoneLayout = window.matchMedia("(max-width: 640px)").matches;
  const total = STATUS_BOARD_STAGES.reduce((sum, [stage]) => sum + baseView.stages[stage].length, 0);
  console.assert(total === baseView.visibleRows.length, "Status board stage counts must equal visible records.");
  STATUS_BOARD_STAGES.forEach(([stage]) => {
    const statusTotal = [...statusCounts[stage].values()].reduce((sum, count) => sum + count, 0);
    console.assert(statusTotal === stages[stage].length, `Status board ${stage} status counts must match its records.`);
  });
  console.assert(new Set(visibleRows.map((row) => row.id)).size === visibleRows.length, "A delivery must not appear in multiple stages.");
  statusBoardRenderSummary(baseView.stages);
  statusBoardRenderStageTabs(stages);
  if (phoneLayout) {
    statusBoardRenderKanban(stages, statusCounts, statusBoardSelectedStage);
  } else {
    statusBoardRenderKanban(stages, statusCounts);
  }
  statusBoardRenderTableDialog();
}

function statusBoardUpdateMovement(type, rows, columnOf) {
  const previous = new Map([...statusBoardPreviousColumns]
    .filter(([key]) => key.startsWith(`${type}:`)));
  const current = new Map(rows.map((row) => [`${type}:${row.id}`, columnOf(row)]));
  if (statusBoardLoadedWorkflows.has(type)) {
    current.forEach((column, key) => {
      if (previous.get(key) === column) return;
      statusBoardMovedKeys.add(key);
      window.clearTimeout(statusBoardMovedTimers.get(key));
      statusBoardMovedTimers.set(key, window.setTimeout(() => {
        statusBoardMovedKeys.delete(key);
        statusBoardMovedTimers.delete(key);
        document.querySelectorAll("[data-board-key]").forEach((card) => {
          if (card.dataset.boardKey === key) card.classList.remove("status-board-card-moved");
        });
      }, 6000));
    });
  }
  for (const key of previous.keys()) statusBoardPreviousColumns.delete(key);
  current.forEach((column, key) => statusBoardPreviousColumns.set(key, column));
  statusBoardLoadedWorkflows.add(type);
}

function statusBoardWorkflowColumn(type, row) {
  if (type === "artworks") {
    const status = String(row.status || "").trim().toLowerCase();
    return status === "done" ? "Done"
      : status === "change requested" ? "Change requested"
        : status === "in progress" ? "In progress" : "Requested";
  }
  if (row.status === "Not started") return row.assigned_rider ? "Assigned" : "Awaiting rider";
  if (row.status === "Started") return "Started";
  if (row.status === "In progress") return "In progress";
  if (row.status === "Finished") return "Finished";
  if (row.status === "Declined") return "Declined";
  return "Awaiting rider";
}

function statusBoardWorkflowPersonId(type, row) {
  return STATUS_BOARD_WORKFLOW_CONFIG[type].personId(row);
}

function statusBoardWorkflowPersonName(type, row) {
  const id = statusBoardWorkflowPersonId(type, row);
  if (!id || id === "__unknown") return "—";
  return statusBoardProfiles.get(id) || "—";
}

function statusBoardClosedRange(type, row, column, todayValue) {
  if (!column.closed) return true;
  const selected = statusBoardWorkflowFilters[type].date;
  if (selected === "all") return true;
  const closedDate = statusBoardDate(column.date(row));
  if (!closedDate) return false;
  if (selected === "today") return closedDate === todayValue;
  if (selected === "week") {
    const from = new Date(`${todayValue}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 6);
    return closedDate >= from.toISOString().slice(0, 10) && closedDate <= todayValue;
  }
  return closedDate.slice(0, 7) === todayValue.slice(0, 7);
}

function statusBoardWorkflowDate(type, row) {
  return type === "artworks" ? row.date_needed : row.scheduled_date;
}

function statusBoardWorkflowSearchValues(type, row) {
  const person = statusBoardWorkflowPersonName(type, row);
  return [
    row.ref_no, row.sr, row.client_name, row.address, person,
    type === "artworks" ? row.created_by : row.assigned_rider,
    type === "artworks" ? statusBoardDesignerName(row) : row.job_type,
    type === "artworks" ? row.preferred_designer : row.details,
    type === "artworks" ? row.product : row.job_type
  ];
}

function statusBoardWorkflowRows(type) {
  return type === "artworks" ? statusBoardArtworkRows : statusBoardRiderRows;
}

function statusBoardBuildWorkflowUi() {
  Object.entries(STATUS_BOARD_WORKFLOW_CONFIG).forEach(([type, config]) => {
    const panel = document.getElementById(config.panelId);
    const dateOptions = [
      ["today", "Today"],
      ["week", "Last 7 days"],
      ["month", "This month"],
      ["all", "All dates"]
    ];
    panel.innerHTML = `
      <section class="status-board-summary" data-board-summary aria-label="${escapeHtml(type)} summary"></section>
      <section class="panel status-board-filters status-board-workflow-filters">
        <div class="status-board-filter-row">
          <label>Search<input type="search" data-board-search placeholder="Reference, SR, client, address or person"></label>
          <label>${escapeHtml(config.personLabel)}<select data-board-person><option value="">All ${escapeHtml(config.personLabel.toLowerCase())}s</option></select></label>
          <label>Closed date range<select data-board-date>${dateOptions.map(([value, label]) =>
            `<option value="${value}">${label}</option>`).join("")}</select></label>
          <button type="button" class="secondary" data-board-reset>Reset</button>
        </div>
      </section>
      <div class="status-board-kanban" data-board-kanban data-cols="${config.columns.length}"
        aria-label="${escapeHtml(type)} by status"></div>`;
    const filters = statusBoardWorkflowFilters[type];
    const search = panel.querySelector("[data-board-search]");
    const person = panel.querySelector("[data-board-person]");
    const date = panel.querySelector("[data-board-date]");
    search.value = filters.search;
    person.value = filters.person;
    date.value = filters.date;
    search.addEventListener("input", debounce(() => {
      filters.search = search.value;
      statusBoardRenderWorkflow(type);
    }, 250));
    person.addEventListener("change", () => {
      filters.person = person.value;
      statusBoardRenderWorkflow(type);
    });
    date.addEventListener("change", () => {
      filters.date = date.value;
      statusBoardRenderWorkflow(type);
    });
    panel.querySelector("[data-board-reset]").addEventListener("click", () => {
      filters.search = "";
      filters.person = "";
      filters.date = "all";
      search.value = "";
      person.value = "";
      date.value = "all";
      statusBoardRenderWorkflow(type);
    });
  });
}

function statusBoardWorkflowCard(type, row, column) {
  const boardKey = `${type}:${row.id}`;
  const moved = statusBoardMovedKeys.has(boardKey) ? " status-board-card-moved" : "";
  const colour = statusBoardColour(row.status);
  const status = String(row.status || column.key || "—");
  const person = statusBoardWorkflowPersonName(type, row);
  const dueDate = statusBoardWorkflowDate(type, row);
  const due = statusBoardDueState(dueDate, column.closed);
  const badges = [
    statusBoardDueBadge(dueDate, column.closed),
    type === "riders" && row.status === "Declined" && row.decline_reason
      ? `<span class="status-board-decline-reason">${escapeHtml(row.decline_reason)}</span>` : ""
  ].filter(Boolean).join("");
  const href = type === "artworks" ? "./admin.html" : "./route-admin.html";
  const title = row.ref_no || row.sr || "—";
  const meta = type === "artworks"
    ? `Salesperson: ${escapeHtml(person)}<br>Designer: ${escapeHtml(statusBoardDesignerName(row))}<br>Needed: ${escapeHtml(statusBoardDateLabel(row.date_needed))}<br>Changes: ${escapeHtml(row.change_count ?? 0)}`
    : `Rider: ${escapeHtml(person)}<br>Scheduled: ${escapeHtml(statusBoardDateLabel(row.scheduled_date))}<br>Expected: ${escapeHtml(row.expected_time || "—")}`;
  const fields = type === "artworks"
    ? `<div class="status-board-card-meta">${meta}</div>`
    : `<div class="status-board-card-meta">${meta}</div>
       <div class="status-board-card-meta">${escapeHtml(row.job_type || "—")} · ${escapeHtml(row.address || "—")}</div>`;
  const changeCount = type === "artworks" && row.change_count
    ? `<div class="status-board-card-meta">${escapeHtml(row.change_count)} change${Number(row.change_count) === 1 ? "" : "s"}</div>` : "";
  return `<a class="status-board-card status-board-card-${escapeHtml(colour)}${moved}" data-board-key="${escapeHtml(boardKey)}"
    href="${href}?open=${escapeHtml(encodeURIComponent(row.id))}"
    aria-label="${escapeHtml(`${title}, ${row.client_name || "No client"}, ${status}${due ? `, ${due === "overdue" ? "Overdue" : "Due today"}` : ""}`)}">
    <div class="status-board-card-heading"><strong>${escapeHtml(title)}</strong>
      <span class="status-board-status status-board-status-${escapeHtml(colour)}">${escapeHtml(status)}</span></div>
    <div class="status-board-card-client">${escapeHtml(row.client_name || "—")}</div>
    ${fields}${changeCount}${badges ? `<div class="status-board-card-badges">${badges}</div>` : ""}
  </a>`;
}

function statusBoardDesignerName(row) {
  const id = row.assigned_designer && row.assigned_designer !== "__unknown"
    ? row.assigned_designer
    : row.preferred_designer;
  if (!id || id === "__unknown") return "—";
  return statusBoardProfiles.get(id) || "—";
}

function statusBoardRenderWorkflow(type) {
  const config = STATUS_BOARD_WORKFLOW_CONFIG[type];
  const panel = document.getElementById(config.panelId);
  const root = panel.querySelector("[data-board-kanban]");
  const filters = statusBoardWorkflowFilters[type];
  const todayValue = statusBoardToday();
  const search = filters.search.trim().toLowerCase();
  const rows = statusBoardWorkflowRows(type).filter((row) => {
    if (filters.person && statusBoardWorkflowPersonId(type, row) !== filters.person) return false;
    if (!search) return true;
    return statusBoardWorkflowSearchValues(type, row)
      .some((value) => String(value || "").toLowerCase().includes(search));
  });
  const columns = config.columns.map((column) => ({
    ...column,
    rows: rows.filter((row) => statusBoardWorkflowColumn(type, row) === column.key
      && statusBoardClosedRange(type, row, column, todayValue))
  }));
  const visibleRows = columns.flatMap((column) => column.rows);
  const overdue = visibleRows.filter((row) => {
    const column = config.columns.find((entry) => entry.key === statusBoardWorkflowColumn(type, row));
    return statusBoardDueState(statusBoardWorkflowDate(type, row), column?.closed) === "overdue";
  }).length;
  const dueToday = visibleRows.filter((row) => {
    const column = config.columns.find((entry) => entry.key === statusBoardWorkflowColumn(type, row));
    return statusBoardDueState(statusBoardWorkflowDate(type, row), column?.closed) === "today";
  }).length;
  const closedCount = columns.filter((column) => column.closed)
    .reduce((sum, column) => sum + column.rows.length, 0);
  const openCount = visibleRows.length - closedCount;
  const summaries = [
    ["Total", visibleRows.length, "blue"],
    ["Open", openCount, "purple"],
    ["Due today", dueToday, "orange"],
    ["Overdue", overdue, "red"],
    ["Closed", closedCount, "green"]
  ];
  panel.querySelector("[data-board-summary]").innerHTML = summaries.map(([label, count, colour]) =>
    `<article class="status-board-summary-card status-board-summary-${colour}"><span>${label}</span><strong>${count}</strong></article>`
  ).join("");

  const people = [...new Set(statusBoardWorkflowRows(type)
    .map((row) => statusBoardWorkflowPersonId(type, row))
    .filter((id) => id && id !== "__unknown"))]
    .map((id) => [id, statusBoardProfiles.get(id) || ""])
    .filter(([, name]) => name)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const personSelect = panel.querySelector("[data-board-person]");
  const selectedPerson = filters.person;
  personSelect.innerHTML = `<option value="">All ${escapeHtml(config.personLabel.toLowerCase())}s</option>`
    + people.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  if (people.some(([id]) => id === selectedPerson)) personSelect.value = selectedPerson;
  else {
    filters.person = "";
    personSelect.value = "";
  }

  root.dataset.cols = String(config.columns.length);
  root.style.setProperty("--board-cols", String(config.columns.length));
  root.innerHTML = columns.map((column) => {
    const sorted = [...column.rows].sort((a, b) => {
      const dateA = new Date(column.date(a) || a.created_at || 0).getTime() || 0;
      const dateB = new Date(column.date(b) || b.created_at || 0).getTime() || 0;
      return column.closed ? dateB - dateA : dateA - dateB;
    });
    const overdueCount = sorted.filter((row) =>
      statusBoardDueState(statusBoardWorkflowDate(type, row), column.closed) === "overdue").length;
    return `<section class="status-board-column" data-stage="${escapeHtml(column.key)}"><header>
      <h2>${escapeHtml(column.title)} <span class="status-board-column-count">${sorted.length}</span></h2>
      <p>${overdueCount} overdue</p></header>
      <div class="status-board-column-cards">${sorted.length
        ? sorted.map((row) => statusBoardWorkflowCard(type, row, column)).join("")
        : '<p class="status-board-nothing">Nothing here</p>'}</div></section>`;
  }).join("");
}

function statusBoardRenderWorkflows() {
  Object.keys(STATUS_BOARD_WORKFLOW_CONFIG).forEach(statusBoardRenderWorkflow);
}

function statusBoardReportRefreshError(key, error, fallback) {
  if (statusBoardReportedQueryErrors.has(key)) return;
  statusBoardReportedQueryErrors.add(key);
  toast(error?.message || fallback, "error");
}

function statusBoardUpdatedText() {
  const updated = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date());
  const live = ["deliveries", "artwork_requests", "rider_jobs"]
    .every((table) => statusBoardChannelStates.get(table) === "SUBSCRIBED");
  document.querySelector("#status-board-updated").innerHTML = live
    ? `<span class="status-board-live">● Live</span> · Updated ${updated}` : `Updated ${updated}`;
}

function statusBoardScheduleRefresh() {
  window.clearTimeout(statusBoardRealtimeTimer);
  statusBoardRealtimeTimer = window.setTimeout(() => {
    if (!document.hidden) void statusBoardRefresh();
  }, 500);
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
    columns: [...document.querySelectorAll(".status-board-column-cards")].map((column) => column.scrollTop)
  };
}

function statusBoardRestoreScroll(scroll) {
  window.scrollTo(window.scrollX, scroll.page);
  document.querySelectorAll(".status-board-column-cards").forEach((column, index) => {
    column.scrollTop = scroll.columns[index] || 0;
  });
}

async function statusBoardRefresh() {
  if (statusBoardLoading) {
    statusBoardRefreshQueued = true;
    return;
  }
  statusBoardLoading = true;
  const scroll = statusBoardCaptureScroll();
  const refreshProfiles = !statusBoardProfilesLoadedAt
    || Date.now() - statusBoardProfilesLoadedAt >= STATUS_BOARD_PROFILES_TTL_MS;
  try {
    const results = await Promise.allSettled([
      client.from("deliveries")
        .select("id,sr,ref_no,created_at,created_by,salesperson_id,goods_status,client_name,contact_name,items,production_status,dispatch_status,ready_at,dispatched_at,delivered_at,delivery_date")
        .order("created_at", { ascending: false }).limit(1000),
      refreshProfiles
        ? client.from("profiles").select("id,full_name").limit(1000)
        : Promise.resolve({ data: null, error: null }),
      client.from("artwork_requests")
        .select("id,created_at,created_by,ref_no,sr,client_name,status,done_at,date_needed,assigned_designer,preferred_designer,change_count,product"),
      client.from("rider_jobs")
        .select("id,sr,ref_no,created_at,client_name,address,job_type,details,expected_time,scheduled_date,assigned_rider,status,decline_reason,declined_at,started_at,finished_at")
    ]);
    const [deliveryResult, profilesResult, artworksResult, ridersResult] = results.map((result) =>
      result.status === "fulfilled" ? result.value : { error: result.reason });
    if (deliveryResult.error) {
      statusBoardReportRefreshError("deliveries", deliveryResult.error, "Could not load delivery statuses.");
    } else {
      statusBoardRows = deliveryResult.data || [];
      statusBoardUpdateMovement("delivery", statusBoardRows, statusBoardStageOf);
      statusBoardReportDataIssues(statusBoardRows);
    }
    if (profilesResult.error) {
      statusBoardReportRefreshError("profiles", profilesResult.error, "Could not load status board people.");
    } else if (profilesResult.data) {
      statusBoardProfiles = new Map((profilesResult.data || []).map((person) => [person.id, person.full_name]));
      statusBoardProfilesLoadedAt = Date.now();
    }
    if (artworksResult.error) {
      statusBoardReportRefreshError("artwork_requests", artworksResult.error, "Could not load artwork statuses.");
    } else {
      statusBoardArtworkRows = artworksResult.data || [];
      statusBoardUpdateMovement("artworks", statusBoardArtworkRows, (row) => statusBoardWorkflowColumn("artworks", row));
    }
    if (ridersResult.error) {
      statusBoardReportRefreshError("rider_jobs", ridersResult.error, "Could not load rider statuses.");
    } else {
      statusBoardRiderRows = ridersResult.data || [];
      statusBoardUpdateMovement("riders", statusBoardRiderRows, (row) => statusBoardWorkflowColumn("riders", row));
    }
    statusBoardRenderSalespeople();
    statusBoardRender();
    statusBoardRenderWorkflows();
    statusBoardRestoreScroll(scroll);
    statusBoardMeasureTop();
    statusBoardUpdatedText();
    if (!deliveryResult.error && !profilesResult.error && !artworksResult.error && !ridersResult.error) {
      statusBoardLastRefreshAt = Date.now();
    }
  } catch (error) {
    statusBoardReportRefreshError("status-board", error, "Could not load the status board.");
  } finally {
    statusBoardLoading = false;
    if (statusBoardRefreshQueued) {
      statusBoardRefreshQueued = false;
      void statusBoardRefresh();
    }
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

export async function initStatusBoard({ profile: currentProfile, page: currentPage }) {
  profile = currentProfile;
  page = currentPage;
  if (!canSeeStatusBoard(profile)) {
    location.replace(`./${homePageForRole()}`);
    return;
  }
  const todayDate = statusBoardDate(new Date());
  statusBoardBuildWorkflowUi();
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
  document.querySelector("#status-board-reset").addEventListener("click", () => {
    document.querySelector("#status-board-search").value = "";
    document.querySelector("#status-board-salesperson").value = "";
    document.querySelector("#status-board-date-from").value = todayDate;
    document.querySelector("#status-board-date-to").value = todayDate;
    statusBoardSelectedStage = "all";
    statusBoardSummaryFilter = "all";
    if (document.querySelector("#status-board-table-dialog").open) {
      document.querySelector("#status-board-table-dialog").close();
    }
    statusBoardSelectTab("deliveries");
    statusBoardRender();
  });
  const liveTables = ["deliveries", "artwork_requests", "rider_jobs"];
  statusBoardLiveChannels = liveTables.map((table) => client.channel(`status-board-${table}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, statusBoardScheduleRefresh)
    .subscribe((state) => {
      statusBoardChannelStates.set(table, state);
      statusBoardUpdatedText();
    }));
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
  document.querySelectorAll("[data-status-table-close]").forEach((button) =>
    button.addEventListener("click", () => document.querySelector("#status-board-table-dialog").close())
  );
  document.querySelector("#status-board-table-dialog").addEventListener("close", () => {
    statusBoardTableDialogView = null;
    statusBoardRenderStageTabs(statusBoardApplySummaryFilter(statusBoardBuildView()).stages);
  });
  document.querySelector("#status-board-table-print").addEventListener("click", () => {
    statusBoardRenderTableDialog();
    window.print();
  });
  document.querySelector("#status-board-table-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.querySelector("#status-board-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  await statusBoardRefresh();
  statusBoardRefreshTimer = window.setInterval(() => {
    if (!document.hidden) void statusBoardRefresh();
  }, STATUS_BOARD_REFRESH_MS);
  const onVisibilityChange = () => {
    if (!document.hidden && Date.now() - statusBoardLastRefreshAt >= 60000) void statusBoardRefresh();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    if (statusBoardRefreshTimer !== null) window.clearInterval(statusBoardRefreshTimer);
    window.clearTimeout(statusBoardRealtimeTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    statusBoardLiveChannels.forEach((channel) => { void client.removeChannel(channel); });
    statusBoardMovedTimers.forEach((timer) => window.clearTimeout(timer));
    statusBoardMovedTimers.clear();
  }, { once: true });
}
