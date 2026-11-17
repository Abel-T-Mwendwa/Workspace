export function toast(message, type = "success") {
  const root = document.querySelector("#toast-root");
  root.replaceChildren();
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  root.append(item);
  setTimeout(() => item.remove(), 4200);
}
