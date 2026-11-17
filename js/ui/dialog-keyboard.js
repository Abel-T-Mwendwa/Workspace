export function bindEditorKeyboard(dialog) {
  dialog.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      const save = dialog.querySelector("[data-shortcut-save]");
      if (save && !save.disabled) {
        event.preventDefault();
        save.click();
      }
      return;
    }
    const rowSelector = dialog.id === "line-editor-dialog" ? ".line-editor-row"
      : dialog.id === "branding-editor-dialog" ? ".branding-detail-row" : ".delivery-item-row";
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") {
      const row = event.target.closest(rowSelector);
      const fields = [...(row?.querySelectorAll("input, select") || [])];
      if (row) {
        event.preventDefault();
        const fieldIndex = fields.indexOf(event.target);
        const nextField = fields[fieldIndex + 1];
        if (nextField) nextField.focus();
        else if (row.nextElementSibling?.matches(rowSelector)) row.nextElementSibling.querySelector("input, select")?.focus();
        else {
          dialog.querySelector("[data-shortcut-add]")?.click();
          dialog.querySelector(`${rowSelector}:last-child input[type="text"]`)?.focus();
        }
        return;
      }
    }
    if (event.key !== "Tab") return;
    const rows = [...dialog.querySelectorAll(rowSelector)];
    const ordered = rows.flatMap((row) => {
      const fields = dialog.id === "branding-editor-dialog"
        ? ["input[aria-label^='Logo']", "select", "input[aria-label^='Pantone']", "input[aria-label^='Size']", "input[aria-label^='Position']"]
        : [...row.querySelectorAll("input, select")];
      const controls = Array.isArray(fields) && typeof fields[0] === "string"
        ? fields.map((selector) => row.querySelector(selector)).filter(Boolean)
        : fields;
      const remove = row.querySelector("[data-shortcut-remove]");
      return remove ? [...controls, remove] : controls;
    });
    const add = dialog.querySelector("[data-shortcut-add]");
    const discard = dialog.querySelector("#branding-dialog-actions .quiet, #delivery-item-discard");
    const save = dialog.querySelector("[data-shortcut-save]");
    const close = dialog.querySelector("[data-branding-close], [data-items-close]");
    const focusables = [...ordered, add, discard, save, close]
      .filter((element) => element && !element.disabled && !element.classList.contains("hidden"));
    if (!focusables.length) return;
    const index = focusables.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      focusables.at(-1).focus();
    } else if (!event.shiftKey && (index === -1 || index === focusables.length - 1)) {
      event.preventDefault();
      focusables[0].focus();
    } else if (index >= 0) {
      event.preventDefault();
      focusables[index + (event.shiftKey ? -1 : 1)]?.focus();
    }
  });
}
