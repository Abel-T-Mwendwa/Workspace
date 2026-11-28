export const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function localDate(value) {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T12:00:00+03:00`)
    : new Date(value);
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Africa/Nairobi" }).format(date);
}

export function localDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(value));
}

export function dateKey(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

export function periodBounds(period) {
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
