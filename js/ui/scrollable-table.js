let getPage;
let getProfile;
let initializeDeliveryStickyScrollbar;
let tableRowSliderObserver;

export function configureScrollableTables({
  getPage: getPageCallback,
  getProfile: getProfileCallback,
  initializeDeliveryStickyScrollbar: initializeDeliveryStickyScrollbarCallback
}) {
  getPage = getPageCallback;
  getProfile = getProfileCallback;
  initializeDeliveryStickyScrollbar = initializeDeliveryStickyScrollbarCallback;
}

function tableColumnWidth(header, index) {
  const label = header.textContent.trim().toLowerCase();
  if (index === 0 && /^(sr|#|no\.?)(\s*\/.*)?$/.test(label)) return 82;
  if (index === 0 && /^ref(\s+no\.?)?$/.test(label)) return 140;
  if (/^(production access|dispatch access|route admin access|production store access|rider request access|active)$/.test(label)) return 116;
  if (/^(action|actions|manage)$/.test(label)) return 270;
  if (/(^| )status$/.test(label) || /^(production|dispatch|type|category)$/.test(label)) return 150;
  if (/(date|time|needed|requested|delivery|expected)$/.test(label)) return 156;
  if (/^(quantity|quantity \(pcs\))$/.test(label)) return 132;
  if (/^(name|username|salesperson|rider|designer preferred|client|client \/ contact|ref no|ref \/ client|registration)$/.test(label)) return 184;
  if (/(item|address|details|description|product|branding|notes|reference|expected|transport|vehicle)/.test(label)) return 224;
  return 164;
}

export function initializeScrollableTableRow(row) {
  const table = row.closest("table");
  const headers = table.querySelectorAll("thead th");
  if (table.classList.contains("delivery-page-table")) {
    [...headers].forEach((header, index) => {
      if (row.cells[index]) {
        row.cells[index].removeAttribute("style");
        row.cells[index].dataset.label = header.textContent.trim();
      }
    });
    return;
  }
  [...headers].forEach((header, index) => {
    if (header.style.width && row.cells[index]) row.cells[index].style.width = header.style.width;
  });
}

export function initializeScrollableTables(root = document) {
  const tables = root instanceof HTMLTableElement ? [root] : [...root.querySelectorAll("table")];
  tables.forEach((table) => {
    table.classList.add("table-scroll-content");
    const deliveryPageTable = table.id === "deliveries-table" && getPage() === "deliveries.html";
    if (deliveryPageTable) {
      table.classList.add("delivery-page-table");
      table.classList.toggle("delivery-salesperson-table", getProfile()?.role === "salesperson");
      table.closest(".table-wrap")?.classList.add("delivery-salesperson-table-wrap");
      table.style.removeProperty("--table-scroll-width");
      table.style.removeProperty("width");
      table.style.removeProperty("min-width");
      table.style.removeProperty("table-layout");
      table.querySelectorAll("thead th").forEach((header) => header.removeAttribute("style"));
      table.querySelectorAll("tr").forEach((row) => initializeScrollableTableRow(row));
      initializeDeliveryStickyScrollbar();
      return;
    }
    const headers = [...table.querySelectorAll("thead th")];
    const widths = headers.map(tableColumnWidth);
    if (!widths.length) return;
    table.style.setProperty("--table-scroll-width", `${widths.reduce((total, width) => total + width, 0)}px`);
    headers.forEach((header, index) => {
      header.style.width = `${widths[index]}px`;
    });
    table.querySelectorAll("tr").forEach((row) => {
      [...row.cells].forEach((cell, index) => {
        if (widths[index] !== undefined) cell.style.width = `${widths[index]}px`;
      });
    });
  });

  if (root !== document || tableRowSliderObserver || !document.body) return;
  tableRowSliderObserver = new MutationObserver((records) => {
    const changedTables = new Set();
    records.forEach(({ target, addedNodes }) => {
      if (target instanceof HTMLTableSectionElement && target.closest("table")?.classList.contains("table-scroll-content")) {
        addedNodes.forEach((node) => {
          if (node instanceof HTMLTableRowElement) initializeScrollableTableRow(node);
        });
        return;
      }
      if (target instanceof Element) {
        const table = target.closest("table");
        if (table) changedTables.add(table);
      }
      addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node instanceof HTMLTableElement) changedTables.add(node);
        else node.querySelectorAll("table").forEach((table) => changedTables.add(table));
      });
    });
    changedTables.forEach((table) => initializeScrollableTables(table));
  });
  tableRowSliderObserver.observe(document.body, { childList: true, subtree: true });
}
