let page;
let rerender;
let SORT_STATE_KEY;
let SORT_KEYS;
let savedSortState;
let activeSort;
let userSortKey;

export function configureTableSort({ page: currentPage, rerender: rerenderPage }) {
  page = currentPage;
  rerender = rerenderPage;
  SORT_STATE_KEY = `artworkSort:${page}`;
  SORT_KEYS = ["sr", "created_month", "created_at", "ref_no", ...(page === "designer.html" ? ["date_needed"] : []), ...(["deliveries.html", "production-store.html"].includes(page) ? ["delivery_schedule"] : [])];
  savedSortState = ["deliveries.html", "production-store.html"].includes(page) ? null : readSortState();
  activeSort = savedSortState || (page === "designer.html"
    ? { key: "date_needed", direction: "desc" }
    : ["deliveries.html", "production-store.html"].includes(page) ? { key: "delivery_schedule", direction: "asc" }
      : { key: "sr", direction: "asc" });
  userSortKey = savedSortState?.key || (page === "designer.html" ? "date_needed" : ["deliveries.html", "production-store.html"].includes(page) ? "delivery_schedule" : null);
}

function readSortState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STATE_KEY) || "null");
    return saved && SORT_KEYS.includes(saved.key) && ["asc", "desc"].includes(saved.direction) ? saved : null;
  } catch (error) {
    console.error("Could not read the table sort preference.", error);
    return null;
  }
}

export function setActiveSort(sort, key) {
  activeSort = sort;
  userSortKey = key;
}

export function sortRows(rows) {
  const direction = activeSort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (activeSort.key === "sr") {
      comparison = Number(left.sr) - Number(right.sr);
    } else if (activeSort.key === "created_month") {
      comparison = String(left.created_month || "").localeCompare(String(right.created_month || ""));
    } else if (activeSort.key === "created_at") {
      comparison = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    } else if (activeSort.key === "ref_no") {
      comparison = String(left.ref_no || "").localeCompare(String(right.ref_no || ""), undefined, { numeric: true, sensitivity: "base" });
    } else if (activeSort.key === "date_needed") {
      const leftDate = left.date_needed ? Date.parse(`${left.date_needed}T00:00:00`) : NaN;
      const rightDate = right.date_needed ? Date.parse(`${right.date_needed}T00:00:00`) : NaN;
      if (!Number.isFinite(leftDate)) return Number.isFinite(rightDate) ? 1 : 0;
      if (!Number.isFinite(rightDate)) return -1;
      comparison = leftDate - rightDate;
    } else if (activeSort.key === "delivery_schedule") {
      const leftDay = left.delivery_date ? Date.parse(`${left.delivery_date}T00:00:00`) : NaN;
      const rightDay = right.delivery_date ? Date.parse(`${right.delivery_date}T00:00:00`) : NaN;
      if (!Number.isFinite(leftDay)) return Number.isFinite(rightDay) ? 1 : 0;
      if (!Number.isFinite(rightDay)) return -1;
      if (leftDay !== rightDay) {
        comparison = leftDay - rightDay;
      } else {
        const leftTime = left.delivery_time ? Date.parse(`${left.delivery_date}T${left.delivery_time}`) : NaN;
        const rightTime = right.delivery_time ? Date.parse(`${right.delivery_date}T${right.delivery_time}`) : NaN;
        if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
        if (!Number.isFinite(rightTime)) return -1;
        comparison = leftTime - rightTime;
      }
    }
    return comparison * direction;
  });
}

export function updateSortIndicators() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const label = header.dataset.sortLabel || header.textContent.trim();
    header.dataset.sortLabel = label;
    header.title = page === "deliveries.html" || page === "production-store.html" || page === "designer.html" && header.dataset.sort === "date_needed" ? "Click to sort" : "Double-click to sort";
    header.classList.add("sortable-header");
    const active = header.dataset.sort === activeSort.key;
    const indicator = document.createElement("span");
    indicator.className = "sort-indicator";
    indicator.textContent = `${label}${active ? (activeSort.direction === "asc" ? " ▲" : " ▼") : ""}`;
    header.replaceChildren(indicator);
    header.setAttribute("aria-sort", active ? (activeSort.direction === "asc" ? "ascending" : "descending") : "none");
  });
}

export function bindSortableHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    const toggleSort = () => {
      activeSort = userSortKey === header.dataset.sort
        ? { key: activeSort.key, direction: activeSort.direction === "asc" ? "desc" : "asc" }
        : { key: header.dataset.sort, direction: "asc" };
      userSortKey = header.dataset.sort;
      if (page !== "deliveries.html") {
        try {
          localStorage.setItem(SORT_STATE_KEY, JSON.stringify(activeSort));
        } catch (error) {
          console.error("Could not save the table sort preference.", error);
        }
      }
      rerender();
    };
    header.addEventListener(page === "deliveries.html" || page === "production-store.html" || page === "designer.html" && header.dataset.sort === "date_needed" ? "click" : "dblclick", toggleSort);
    if (page === "production-store.html") {
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleSort();
      });
    }
  });
  updateSortIndicators();
}
