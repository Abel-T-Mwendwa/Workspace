import { client } from "../core/supabase-client.js";
import { toast } from "../ui/toast.js";
import { setBusy } from "../ui/busy.js";
import { escapeHtml } from "../utils/escape-html.js";
import { initializeScrollableTables } from "../ui/scrollable-table.js";
import { periodBounds } from "../utils/dates.js";
import { tallyMarkup } from "../features/activity-panel.js";
import { invokeAdmin } from "../services/admin.service.js";
import { bindPasswordHints } from "../ui/password-hints.js";
import { fetchProfiles } from "../services/users.service.js";

let users = [];
let profile;

async function loadUsers() {
  users = await fetchProfiles(); return users;
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  if (String(new FormData(form).get("password")).length < 8) {
    toast("Password must be at least 8 characters.", "error");
    return;
  }
  setBusy(button, true);
  try {
    const formData = new FormData(form);
    const values = Object.fromEntries(formData);
    values.production_access = formData.has("production_access");
    values.dispatch_access = formData.has("dispatch_access");
    values.route_admin_access = formData.has("route_admin_access");
    values.production_store_access = formData.has("production_store_access");
    values.rider_request_access = formData.has("rider_request_access");
    await invokeAdmin("create_user", values);
    form.reset();
    toast("User created. Share the temporary password securely.");
    await loadUsers();
    renderUsers();
    renderUserTallies();
  } catch (error) {
    toast(error.message || "Could not create user.", "error");
  } finally {
    setBusy(button, false);
  }
}

function renderUsers() {
  const roleOptions = [...document.querySelector("#user-create-form [name='role']").options]
    .map((option) => ({ value: option.value, label: option.textContent }));
  const roleFilter = document.querySelector("#users-role-filter");
  if (roleFilter.options.length === 1) {
    roleFilter.innerHTML += roleOptions.map((role) =>
      `<option value="${escapeHtml(role.value)}">${escapeHtml(role.label)}</option>`
    ).join("");
  }
  const search = document.querySelector("#users-search").value.trim().toLowerCase();
  const selectedRole = roleFilter.value;
  const activeFilter = document.querySelector("#users-active-filter").value;
  const filteredUsers = users.filter((user) =>
    (!search || `${user.full_name} ${user.username}`.toLowerCase().includes(search))
    && (!selectedRole || user.role === selectedRole)
    && (!activeFilter || user.active === (activeFilter === "active")));
  document.querySelector("#users-results-count").textContent = `Showing ${filteredUsers.length} ${filteredUsers.length === 1 ? "user" : "users"}`;
  document.querySelector("#users-empty").classList.toggle("hidden", filteredUsers.length > 0);
  document.querySelector("#user-rows").innerHTML = filteredUsers.map((user) => `<tr><td>${escapeHtml(user.full_name)}</td><td>${escapeHtml(user.username)}</td>
    <td><select data-role="${escapeHtml(user.id)}">${roleOptions.map((role) => `<option value="${escapeHtml(role.value)}"${user.role === role.value ? " selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select></td>
    <td><input type="checkbox" data-production-access="${escapeHtml(user.id)}" ${user.production_access || user.role === "production" ? "checked" : ""} ${user.role === "production" ? "disabled" : ""} aria-label="Production access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-dispatch-access="${escapeHtml(user.id)}" ${user.dispatch_access || user.role === "dispatch" ? "checked" : ""} ${user.role === "dispatch" ? "disabled" : ""} aria-label="Dispatch access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-route-admin="${escapeHtml(user.id)}" ${user.route_admin_access || user.role === "route_admin" || user.role === "admin" ? "checked" : ""} ${user.role === "route_admin" || user.role === "admin" ? "disabled" : ""} aria-label="Route admin access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-production-store="${escapeHtml(user.id)}" ${user.production_store_access || user.role === "production_store" ? "checked" : ""} ${user.role === "production_store" ? "disabled" : ""} aria-label="Production store access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-rider-request="${escapeHtml(user.id)}" ${user.rider_request_access || user.role === "user" ? "checked" : ""} ${user.role === "user" ? "disabled" : ""} aria-label="Rider request access for ${escapeHtml(user.full_name)}"></td>
    <td><input type="checkbox" data-active="${escapeHtml(user.id)}" ${user.active ? "checked" : ""} aria-label="Active"></td><td><div class="table-actions">
    <button class="secondary" data-reset="${escapeHtml(user.id)}">Reset password</button><button class="quiet" data-view-password="${escapeHtml(user.id)}">View password</button>
    ${profile?.role === "admin" ? `<button class="danger" data-delete-user="${escapeHtml(user.id)}" ${user.id === profile.id || user.role === "admin" && users.filter((entry) => entry.role === "admin").length <= 1 ? "disabled" : ""}>Delete user</button>` : ""}</div></td></tr>`).join("");
  initializeScrollableTables(document.querySelector("#user-rows").closest("table"));
  document.querySelectorAll("[data-role]").forEach((select) => select.addEventListener("change", () => updateUser(select.dataset.role, { role: select.value }, select)));
  document.querySelectorAll("[data-production-access]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.productionAccess, { production_access: input.checked }, input)));
  document.querySelectorAll("[data-dispatch-access]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.dispatchAccess, { dispatch_access: input.checked }, input)));
  document.querySelectorAll("[data-route-admin]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.routeAdmin, { route_admin_access: input.checked }, input)));
  document.querySelectorAll("[data-production-store]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.productionStore, { production_store_access: input.checked }, input)));
  document.querySelectorAll("[data-rider-request]").forEach((input) => input.addEventListener("change", () =>
    updateUser(input.dataset.riderRequest, { rider_request_access: input.checked }, input)));
  document.querySelectorAll("[data-active]").forEach((input) => input.addEventListener("change", () => updateUser(input.dataset.active, { active: input.checked }, input)));
  document.querySelectorAll("[data-reset]").forEach((button) => button.addEventListener("click", () => {
    const form = document.querySelector("#password-form");
    form.reset(); form.elements.user_id.value = button.dataset.reset;
    document.querySelector("#password-dialog").showModal();
  }));
  document.querySelectorAll("[data-view-password]").forEach((button) => button.addEventListener("click", () => viewPassword(button.dataset.viewPassword, button)));
  document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", () => deleteUser(button)));
}

async function deleteUser(button) {
  const target = users.find((user) => user.id === button.dataset.deleteUser);
  if (profile?.role !== "admin" || !target) return;
  if (target.id === profile.id) {
    toast("You cannot delete your own account.", "error");
    return;
  }
  if (target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) {
    toast("The last remaining administrator cannot be deleted.", "error");
    return;
  }
  if (!confirm(`Delete user ${target.full_name}? This cannot be undone.`)) return;
  setBusy(button, true, "Deleting…");
  try {
    await invokeAdmin("delete_user", { user_id: target.id });
    await loadUsers();
    renderUsers();
    renderUserTallies();
    toast(`User ${target.full_name} deleted.`);
  } catch (error) {
    toast(error.message || "Could not delete user.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function updateUser(id, changes, control) {
  setBusy(control, true);
  try {
    const values = changes.role === "production_store"
      ? { ...changes, production_store_access: true }
      : changes.role === "user" ? { ...changes, rider_request_access: true } : changes;
    const { error } = await client.from("profiles").update(values).eq("id", id);
    if (error) throw error;
    toast("User updated.");
    await loadUsers();
    renderUsers();
    renderUserTallies();
  } catch (error) {
    toast(error.message || "Could not update user.", "error");
    await loadUsers();
    renderUsers();
  } finally {
    setBusy(control, false);
  }
}

function renderUserTallies() {
  const roleOptions = ["salesperson", "designer", "production", "production_store", "dispatch", "route_admin", "rider", "user", "admin"];
  const activeCount = users.filter((user) => user.active).length;
  const inPeriod = periodBounds(document.querySelector("#users-period").value);
  document.querySelector("#user-tallies").innerHTML = tallyMarkup([
    ["Total users", users.length],
    ["Active users", activeCount],
    ["Created in period", users.filter((user) => inPeriod(user.created_at)).length],
    ...roleOptions.map((role) => [role === "production_store" ? "Production store" : role === "user" ? "User" : role.replace("_", " "), users.filter((user) => user.role === role).length])
  ]);
}

export async function initUsers({ profile: currentProfile }) {
  profile = currentProfile;
  await loadUsers();
  renderUsers();
  renderUserTallies();
  document.querySelector("#users-search").addEventListener("input", renderUsers);
  document.querySelector("#users-role-filter").addEventListener("change", renderUsers);
  document.querySelector("#users-active-filter").addEventListener("change", renderUsers);
  document.querySelector("#users-clear-filters").addEventListener("click", () => {
    document.querySelector("#users-search").value = "";
    document.querySelector("#users-role-filter").value = "";
    document.querySelector("#users-active-filter").value = "";
    renderUsers();
  });
  document.querySelector("#users-period").addEventListener("change", renderUserTallies);
  document.querySelector("#user-create-form").addEventListener("submit", createUser);
  document.querySelector("#password-form").addEventListener("submit", resetPassword);
  bindPasswordHints(document);
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
}

async function resetPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  if (String(new FormData(form).get("password")).length < 8) {
    toast("Password must be at least 8 characters.", "error");
    return;
  }
  setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(form));
    await invokeAdmin("reset_password", values);
    document.querySelector("#password-dialog").close();
    toast("Password reset successfully.");
  } catch (error) {
    toast(error.message || "Could not reset password.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function viewPassword(userId, button) {
  setBusy(button, true, "Loading…");
  try {
    const result = await invokeAdmin("view_password", { user_id: userId });
    document.querySelector("#view-password-value").textContent = result.password;
    document.querySelector("#view-password-dialog").showModal();
  } catch (error) {
    toast(error.message || "Could not view password.", "error");
  } finally {
    setBusy(button, false);
  }
}
