const RIDER_REQUEST_SLOTS = [
  ["09:00", "9:00 AM"],
  ["10:00", "10:00 AM"],
  ["11:00", "11:00 AM"],
  ["12:00", "12:00 PM"],
  ["13:00", "1:00 PM"],
  ["14:00", "2:00 PM"],
  ["15:00", "3:00 PM"],
  ["16:00", "4:00 PM"]
];

function nairobiNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute) + Number(values.second) / 60
  };
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function riderRequestAvailability(date, now = new Date()) {
  const current = nairobiNow(now);
  const sameDayCutoff = 8 * 60 + 15;
  const afternoonCutoff = 12 * 60 + 30;
  const sameDayAllowed = current.minutes < afternoonCutoff;
  const minDate = sameDayAllowed ? current.date : nextDate(current.date);
  const sameDayAfternoonOnly = current.minutes > sameDayCutoff
    && current.minutes < afternoonCutoff;
  const validDate = Boolean(date) && date >= minDate;
  const availableSlots = !validDate ? []
    : date === current.date && sameDayAfternoonOnly
      ? RIDER_REQUEST_SLOTS.filter(([time]) => time >= "14:00")
      : [...RIDER_REQUEST_SLOTS];
  return {
    today: current.date,
    minDate,
    availableSlots,
    hint: date === current.date && sameDayAfternoonOnly
      ? "Only 2 PM to 4 PM available for same-day requests."
      : ""
  };
}

export function validateRiderRequestSlot(date, time, now = new Date()) {
  if (!date) return "Choose a request date.";
  const availability = riderRequestAvailability(date, now);
  if (date < availability.minDate) {
    return availability.minDate === availability.today
      ? "Past dates are not available."
      : "Requests after 12:30 PM must be scheduled for tomorrow or later.";
  }
  if (!time) return "Choose an expected time.";
  if (time === "any") return "";
  if (!availability.availableSlots.some(([slot]) => slot === time)) {
    return availability.hint || "That expected time is no longer available. Choose another date or time.";
  }
  return "";
}

export function riderRequestSlots() {
  return RIDER_REQUEST_SLOTS.map(([value, label]) => ({ value, label }));
}
