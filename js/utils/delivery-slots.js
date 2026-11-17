export const HOURLY_SLOT_RANGE = { start: 6, end: 21 };

export function hourlySlots() {
  const slots = [];
  for (let hour = HOURLY_SLOT_RANGE.start; hour < HOURLY_SLOT_RANGE.end; hour += 1) {
    const start = `${String(hour).padStart(2, "0")}:00`;
    const end = `${String(hour + 1).padStart(2, "0")}:00`;
    slots.push({ start, end, label: `${start} – ${end}` });
  }
  return slots;
}

export function deliverySlotOptions(date, today, currentTime) {
  return hourlySlots().map((slot) => ({
    ...slot,
    disabled: date === today && slot.start <= currentTime
  }));
}

export function deliverySlotLabel(start) {
  if (!start || start === "any") return "Any time";
  const slot = hourlySlots().find((item) => item.start === String(start || "").slice(0, 5));
  return slot?.label || "—";
}

export function currentNairobiTime(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(now);
}
