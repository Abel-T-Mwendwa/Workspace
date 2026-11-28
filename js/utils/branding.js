export const brandingModes = [
  "Embroidery",
  "Screen printing",
  "Digital printing",
  "Sublimation",
  "DTF",
  "Embroidery/sublimation",
  "Large Format"
];

export function normalizeBrandingDetails(value) {
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

export function brandingLineSummary(line) {
  return [line.mode, line.logo, line.pantone, line.size, line.position].filter(Boolean).join(" · ");
}

export function brandingSummary(details) {
  const lines = normalizeBrandingDetails(details);
  const first = lines.length ? brandingLineSummary(lines[0]) : "";
  return `${first || "Click to add"}${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`;
}
