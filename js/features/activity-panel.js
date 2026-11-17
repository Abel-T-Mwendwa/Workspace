import { client } from "../core/supabase-client.js";
import { today, dateKey, localDate } from "../utils/dates.js";
import { escapeHtml } from "../utils/escape-html.js";
import { toast } from "../ui/toast.js";

let getDeliveryPeriod;
let setRouteRows;

export function configureActivityPanel({ getDeliveryPeriod: getDeliveryPeriodCallback, setRouteRows: setRouteRowsCallback }) {
  getDeliveryPeriod = getDeliveryPeriodCallback;
  setRouteRows = setRouteRowsCallback;
}

export function tallyMarkup(items) {
  return items.map(([label, value]) => `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`).join("");
}

export function activityPeriodType(period) {
  return typeof period === "string" ? period : period.type;
}

export function activityPeriodIsCustom(period) {
  const type = activityPeriodType(period);
  return type === "day" ? Boolean(period.date)
    : type === "week" ? Boolean(period.dates?.length)
      : Boolean(period.month);
}

export function activityDateRanges(period) {
  const type = activityPeriodType(period);
  const todayKey = dateKey(today);
  const oneDay = (date) => {
    const end = new Date(`${date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { from: date, to: end.toISOString().slice(0, 10) };
  };
  const monthRange = (month) => {
    const start = new Date(`${month}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  };
  if (type === "day") return [oneDay(typeof period === "object" && period.date ? period.date : todayKey)];
  if (type === "week" && typeof period === "object" && period.dates?.length) {
    return [...new Set(period.dates)].sort().map(oneDay);
  }
  if (type === "month") {
    const month = typeof period === "object" && period.month ? period.month : todayKey.slice(0, 7);
    return [monthRange(month)];
  }
  const start = new Date(`${todayKey}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return [{ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }];
}

export function periodDateRange(period) {
  return activityDateRanges(period)[0];
}

export function activityPeriodSummary(period, titleCase = false) {
  const type = activityPeriodType(period);
  const capitalize = (value) => titleCase ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
  if (type === "day") {
    const date = typeof period === "object" && period.date ? period.date : "";
    return capitalize(date ? localDate(date) : "today");
  }
  if (type === "week") {
    const dates = typeof period === "object" ? [...new Set(period.dates || [])].sort() : [];
    return capitalize(dates.length ? `${dates.length} days selected` : "this week");
  }
  const month = typeof period === "object" && period.month ? period.month : "";
  if (!month) return capitalize("this month");
  return capitalize(new Intl.DateTimeFormat("en", {
    month: "long", year: "numeric", timeZone: "Africa/Nairobi"
  }).format(new Date(`${month}-01T12:00:00+03:00`)));
}

export function activityPeriodDetail(period) {
  const type = activityPeriodType(period);
  if (type === "day") {
    const date = typeof period === "object" && period.date ? period.date : dateKey(today);
    return localDate(date);
  }
  if (type === "week" && typeof period === "object" && period.dates?.length) {
    return [...new Set(period.dates)].sort().map(localDate).join(", ");
  }
  if (type === "month" && typeof period === "object" && period.month) {
    const { from, to } = activityDateRanges(period)[0];
    const end = new Date(`${to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return `${localDate(from)} – ${localDate(end.toISOString().slice(0, 10))}`;
  }
  const { from, to } = activityDateRanges(period)[0];
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${localDate(from)} – ${localDate(end.toISOString().slice(0, 10))}`;
}

export function activityQuery(table, period, card, columns, options = {}) {
  let query = client.from(table).select(columns, options);
  if (card.dateColumn) {
    const ranges = activityDateRanges(period);
    if (ranges.length === 1) {
      query = query.gte(card.dateColumn, `${ranges[0].from}T00:00:00+03:00`)
        .lt(card.dateColumn, `${ranges[0].to}T00:00:00+03:00`);
    } else {
      query = query.or(ranges.map(({ from, to }) =>
        `and(${card.dateColumn}.gte.${from}T00:00:00+03:00,${card.dateColumn}.lt.${to}T00:00:00+03:00)`
      ).join(","));
    }
  }
  for (const [column, value] of Object.entries(card.filters || {})) {
    query = Array.isArray(value) ? query.in(column, value)
      : value === null ? query.is(column, null)
      : value === "notNull" ? query.not(column, "is", null) : query.eq(column, value);
  }
  return query;
}

export async function activityCount(table, period, card) {
  const query = activityQuery(table, period, card, "id", { count: "exact", head: true });
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

export async function activityRows(table, period, card, columns) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await activityQuery(table, period, card, columns)
      .order("created_at", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 1000) return rows;
  }
}

export function renderActivityReport({ title, range, total, printed, message, rows }) {
  document.querySelector("#delivery-activity-heading").textContent = title;
  document.querySelector("#delivery-activity-title").textContent = title;
  document.querySelector("#delivery-activity-range").textContent = range;
  document.querySelector("#delivery-activity-total").textContent = `Total: ${total}`;
  document.querySelector("#delivery-activity-printed").textContent = `Printed on ${printed}`;
  document.querySelector("#delivery-activity-message").textContent = message;
  document.querySelector("#delivery-activity-rows").innerHTML = rows;
  document.querySelector("#delivery-activity-table").classList.toggle("hidden", !rows);
}

export async function renderPeriodSummary(rootId, periodId, table, cards, shouldRender = () => true) {
  const root = document.querySelector(`#${rootId}`);
  const period = periodId === "delivery-period"
    ? getDeliveryPeriod() : document.querySelector(`#${periodId}`)?.value || "day";
  let counts;
  if (rootId === "route-tallies") {
    const rowsByCard = await Promise.all(cards.map((card) => activityRows(table, period, card,
      "id,sr,ref_no,created_at,created_by,client_name,contact_name,contact_number,address,details,assigned_rider,rider_time,rider_time_end,status")));
    setRouteRows(rowsByCard);
    counts = rowsByCard.map((rows) => rows.length);
  } else {
    counts = await Promise.all(cards.map((card) => activityCount(table, period, card)));
  }
  if (!shouldRender()) return;
  const periodLabel = typeof period === "object" && activityPeriodIsCustom(period)
    ? activityPeriodSummary(period) : ({ day: "today", week: "this week", month: "this month" })[activityPeriodType(period)] || period;
  root.innerHTML = tallyMarkup(cards.map((card, index) => [
    rootId === "delivery-tallies" ? `${card.label} ${periodLabel}` : card.label,
    counts[index]
  ]));
}

export function bindPeriodSummary(periodId, update) {
  const refresh = () => update().catch((error) => toast(error.message || "Could not load activity summary.", "error"));
  document.querySelector(`#${periodId}`)?.addEventListener("change", refresh);
  void refresh();
}
