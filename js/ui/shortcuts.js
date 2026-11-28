function isTypingTarget(target) {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function shortcutButton(root, selector) {
  const button = root?.querySelector(selector);
  return button && !button.disabled && !button.closest(".hidden") && button.getClientRects().length ? button : null;
}

export function initShortcuts({ getPage, getProfile, onEscape }) {
  function handleKeyboardShortcuts(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const openDialogs = [...document.querySelectorAll("dialog[open]")];
    const dialog = openDialogs.at(-1);

    if (event.key === "Escape") {
      onEscape();
      if (!dialog) return;
      event.preventDefault();
      if (typeof dialog.requestClose === "function") {
        dialog.requestClose();
      } else {
        const cancelEvent = new Event("cancel", { cancelable: true });
        dialog.dispatchEvent(cancelEvent);
        if (!cancelEvent.defaultPrevented) dialog.close();
      }
      return;
    }

    if (isTypingTarget(event.target)) return;

    if (event.key === "+" || event.key === "=" && event.shiftKey) {
      const addButton = shortcutButton(dialog, "[data-shortcut-add]")
        || (!dialog && getPage() === "sales.html" && getProfile()?.role === "salesperson" ? shortcutButton(document, "#new-request") : null)
        || (!dialog && getPage() === "deliveries.html" && ["salesperson", "admin"].includes(getProfile()?.role)
          ? shortcutButton(document, "#delivery-form-toggle") : null);
      if (addButton) {
        event.preventDefault();
        addButton.click();
      }
      return;
    }

    if (event.key === "-" || event.key === "−") {
      const focusedRow = event.target instanceof Element
        ? event.target.closest(".line-editor-row, .branding-detail-row, .delivery-item-row") : null;
      const row = focusedRow || dialog?.querySelector(".line-editor-row:last-child, .branding-detail-row:last-child, .delivery-item-row:last-child");
      const removeButton = shortcutButton(row, "[data-shortcut-remove]")
        || (dialog?.id === "admin-edit-dialog" && getProfile()?.role === "admin"
          ? shortcutButton(dialog, "#admin-delete") : null);
      if (removeButton) {
        event.preventDefault();
        removeButton.click();
      }
      return;
    }

    if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button"))) {
      const saveButton = shortcutButton(dialog, "[data-shortcut-save]");
      if (saveButton) {
        event.preventDefault();
        saveButton.click();
        return;
      }
      const form = dialog?.querySelector("form") || (event.target instanceof Element ? event.target.closest("form") : null);
      const submitButton = form?.querySelector('[type="submit"]:not(:disabled)');
      if (form && submitButton) {
        event.preventDefault();
        form.requestSubmit(submitButton);
      }
    }
  }

  document.addEventListener("keydown", handleKeyboardShortcuts);
}
