import { client } from "../core/supabase-client.js";
import { startVisibleRefresh } from "../core/visible-refresh.js";
import { renderPeriodSummary, activityCount, bindPeriodSummary } from "../features/activity-panel.js";
import { initializeScrollableTables } from "../ui/scrollable-table.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { escapeHtml } from "../utils/escape-html.js";

let vehicleRows = [];
let vehicleListLastLoadedAt = 0;

async function loadVehicles() {
  const { data, error } = await client.from("vehicles").select("id,registration_number,description,active,created_at")
    .order("registration_number").limit(200);
  if (error) throw error;
  vehicleRows = data || [];
  renderVehicles();
  vehicleListLastLoadedAt = Date.now();
}

function renderVehicles() {
  const root = document.querySelector("#vehicle-rows");
  root.innerHTML = vehicleRows.map((vehicle) => `<tr data-entry-id="${escapeHtml(vehicle.id)}"><td>${escapeHtml(vehicle.registration_number)}</td><td>${escapeHtml(vehicle.description)}</td>
    <td>${vehicle.active ? "Active" : "Inactive"}</td><td><div class="table-actions"><button class="secondary" data-vehicle-edit="${escapeHtml(vehicle.id)}">Edit</button>
    <button class="quiet" data-vehicle-toggle="${escapeHtml(vehicle.id)}">${vehicle.active ? "Deactivate" : "Reactivate"}</button></div></td></tr>`).join("");
  initializeScrollableTables(root.closest("table"));
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

export async function initVehicles({ profile }) {
  const form = document.querySelector("#vehicle-form");
  const refreshVehicleSummary = async () => {
    await renderPeriodSummary("vehicle-tallies", "vehicle-period", "vehicles", [
      { label: "Total", filters: {} },
      { label: "Active", filters: { active: true } }
    ]);
    const used = await activityCount("deliveries", document.querySelector("#vehicle-period").value, {
      dateColumn: "dispatched_at", filters: { vehicle_id: "notNull" }
    });
    document.querySelector("#vehicle-tallies").insertAdjacentHTML("beforeend",
      `<div class="stat-card"><span>Used this period</span><strong>${used}</strong></div>`);
  };
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
      await loadVehicles();
      await refreshVehicleSummary();
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
  bindPeriodSummary("vehicle-period", refreshVehicleSummary);
  client.channel(`vehicles-${profile.id}`).on("postgres_changes", {
    event: "*", schema: "public", table: "vehicles"
  }, () => { void loadVehicles(); }).subscribe();
  startVisibleRefresh(() => loadVehicles(), {
    intervalMs: 60000,
    visibilityMinAgeMs: 60000,
    lastRefreshAt: () => vehicleListLastLoadedAt
  });
}
