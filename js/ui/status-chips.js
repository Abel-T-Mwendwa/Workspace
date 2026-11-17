export function renderStatusChipButtons(root, chips, counts, selected, onSelect, dataName = "statusFilter") {
  root.replaceChildren(...chips.map(({ value, label, style }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `production-goods-chip production-goods-chip-${style}${selected === value ? " is-active" : ""}`;
    button.dataset[dataName] = value;
    button.setAttribute("aria-pressed", String(selected === value));
    button.setAttribute("aria-label", `${label} ${counts.get(value) ?? 0}`);
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "production-goods-chip-count";
    count.textContent = String(counts.get(value) ?? 0);
    button.append(name, count);
    button.addEventListener("click", () => {
      onSelect(value);
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...root.querySelectorAll("button")];
      const index = buttons.indexOf(button);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[nextIndex]?.focus();
    });
    return button;
  }));
}

