import { escapeHtml } from "./escape-html.js";
import { localDateTime } from "./dates.js";

export function deliverySoNumbers(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return [...new Set(items.map((item) => String(item.so_number || "").trim()).filter(Boolean))];
}

export function deliveryAddress(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  return [...new Set(items.map((item) => String(item.address || "").trim()).filter(Boolean))].join(" · ");
}

export function deliveryMissingAddress(row) {
  return !deliveryAddress(row);
}

export function deliveryAddressUrgent(row) {
  return deliveryMissingAddress(row)
    && row.goods_status === "ready"
    && row.production_status === "Ready"
    && row.dispatch_status === "Not delivered";
}

export function deliveryGoodsStatusLabel(status) {
  return ({ ready: "Ready", partial: "Partially", not_ready: "Not ready" })[status] || "—";
}

export function deliveryGoodsStatus(row) {
  return row.goods_status || "";
}

export function deliveryProductionStatusMarkup(row, emptyValue = "—", includeTimestamp = true) {
  const status = row.production_status;
  const timestamp = includeTimestamp && row.ready_at ? `<br><small>${escapeHtml(localDateTime(row.ready_at))}</small>` : "";
  if (!status) return `${emptyValue}${timestamp}`;
  return `<span class="delivery-status-${status === "Ready" ? "green" : "red"}">${escapeHtml(status)}</span>${timestamp}`;
}

export function deliveryDispatchStatusMarkup(row, emptyValue = "—", includeTimestamp = true) {
  const status = row.dispatch_status === "Delivered" ? "Delivered"
    : row.dispatched_at ? "Not delivered" : "Not packed";
  const colour = status === "Delivered" ? "green" : status === "Not delivered" ? "blue" : "orange";
  const timestamp = includeTimestamp && row.dispatched_at
    ? `<br><small>Packed ${escapeHtml(localDateTime(row.dispatched_at))}</small>` : "";
  return `<span class="delivery-status-${colour}">${escapeHtml(status || emptyValue)}</span>${timestamp}`;
}
