# Architecture

## JavaScript map

### `js/core`
- `auth.js` — Supabase auth listeners, logout handlers, and the post-login profile/page gate.
- `session.js` — login timestamp limits, session expiry monitoring, and sign-out/redirect behavior.
- `supabase-client.js` — creates and exports the shared Supabase browser client.
- `visible-refresh.js` — starts the shared visibility-and-interval refresh helper.

### `js/features`
- `activity-panel.js` — generic activity-period queries, tallies, reports, and period control binding.
- `artwork.js` — sales, designer, and admin artwork pages plus shared artwork rendering.
- `branding-dialog.js` — branding line dialog markup, state, rendering, and saves.
- `deliveries.js` — delivery requests, statuses, duplicate checks, dialogs, refresh, and deep links.
- `line-dialog.js` — item-line dialog markup, state, rendering, and saves.
- `password-change.js` — forced temporary-password-change dialog and session refresh.
- `rider-jobs.js` — rider requests, route-admin assignment, rider jobs, and activity reports.

### `js/pages`
- `status-board.js` — status-board page initialization and workflow boards.
- `users.js` — user creation, filtering, editing, deletion, and password actions.
- `vehicles.js` — vehicle list and create/edit/toggle page behavior.

### `js/services`
- `admin.service.js` — invokes the `user-admin` Edge Function.
- `users.service.js` — loads all app profile records, active and inactive, ordered by full name.

### `js/ui`
- `busy.js` — generic submit/control busy-state behavior.
- `dialog-keyboard.js` — keyboard behavior shared by editor dialogs.
- `password-hints.js` — password-length hint binding.
- `scrollable-table.js` — scrollable table initialization and sticky scrollbar support.
- `shortcuts.js` — app keyboard-shortcut registration.
- `status-chips.js` — generic status-chip button rendering.
- `table-sort.js` — table sort configuration, state, indicators, and header binding.
- `toast.js` — generic toast rendering.

### `js/utils`
- `branding.js` — branding modes and structured branding summaries.
- `dates.js` — shared Nairobi-date formatting and period helpers.
- `debounce.js` — generic debounced callback helper.
- `delivery-rows.js` — delivery address and goods-status display helpers.
- `delivery-slots.js` — delivery hourly-slot and Nairobi-time helpers.
- `escape-html.js` — HTML escaping.
- `lines.js` — item-line field names, parsing, and summaries.
- `rider-request-slots.js` — rider date availability and request-slot validation.

### Shared entry points
- `js/portal.js` — role navigation, portal access checks, Home cards, notifications, and role-aware page setup.
- `js/login.js` — login form, session restoration, role routing, and password hints.
- `js/app.js` — central app bootstrap, shared configuration, auth, portal setup, and page init dispatch.

## Layering and imports

- Services call Supabase and Edge Functions; they do not touch the DOM or UI state.
- `js/ui/` contains generic DOM helpers and widgets with no page-specific business rules.
- `js/features/` build page sections or dialogs and own feature-specific module state.
- `js/pages/` combine Supabase/UI/activity helpers for one page.
- `js/utils/` contain pure or DOM-independent formatting and validation helpers.
- No module imports from `js/app.js`; app dependencies are passed in or imported from lower layers.
- Services currently hold only profile loading and the admin Edge Function; most other Supabase queries still live directly in `js/features/` and `js/pages/`.

## Page lifecycle

`index.html` loads `js/login.js`; the app pages load `config.js`, Supabase, and `js/app.js` as an ES module. `bootstrap()` in `js/app.js` calls `loadAuthContext(page)`, loads the portal and password-change gate, then calls one page initializer:

- `sales.html` → `initSales({ profile, page })`
- `designer.html` → `initDesigner({ profile, page })`
- `admin.html` → `initAdmin({ profile, page })`
- `users.html` → `initUsers({ profile })`
- `deliveries.html` or `production-store.html` → `initDeliveries({ profile, page })`
- `riders.html` or `route-admin.html` → `initRiders({ profile, page })`
- `vehicles.html` → `initVehicles({ profile })`
- `my-jobs.html` → `initMyJobs({ profile, page })`
- `status-board.html` → `initStatusBoard({ profile, page })`
- `home.html` — no page-specific init; `initPortal()` provides its role-aware content.

## Shared state

Modules keep mutable state private. Cross-module access is provided with callbacks/getters or parameters:

- `configureActivityPanel()` injects getters/setters for delivery-period and route-activity state.
- `configureScrollableTables()` injects page/profile and delivery-scrollbar callbacks.
- `configureTableSort()` injects the current page and rerender callback.
- `initShortcuts()` injects page/profile getters and an Escape callback.
- Page initializers receive `profile` and, where needed, `page`.

An exported binding cannot replace or reassign an imported module variable in another module. The activity panel needs to store route rows that rider-jobs.js reads. An importing module cannot assign to an exported variable, so rider-jobs.js keeps routeActivityRows private and exports setRouteActivityRows(rows); app.js passes that setter to configureActivityPanel().

## Adding a page

1. Add the HTML page with the app scripts and required DOM IDs.
2. Add page access/navigation entries in `js/portal.js`.
3. Create a focused `js/pages/<name>.js` initializer and module-private state.
4. Put reusable page UI or dialogs in `js/features/`, database operations in `js/services/`, and generic UI/value helpers in `js/ui/` or `js/utils/`.
5. Pass `profile`/`page` or injected callbacks instead of importing `js/app.js`.
6. Import and call the initializer in `bootstrap()` once under the matching filename.
7. If the page has sortable tables, add it to `rerenderSortedPage()` in `js/app.js`.
8. Add the stylesheet/DOM hooks and verify direct URL access, logout, and Realtime refresh behavior.

## Checking changes

Run `npm run lint` or `npx eslint js`. The `npm run lint` script runs ESLint over `js/`. Use the role and workflow checklists in `qa/`:
- `qa/QA_REFERENCE.md`
- `qa/QA_REPORT.md`
- `qa/test-artwork-requests.txt`
- `qa/test-deliveries-rider-requests.txt`

## Known debt

- Large files: run `wc -l` to check current sizes for `js/features/deliveries.js`, `js/features/artwork.js`, `js/pages/status-board.js`, `js/features/rider-jobs.js`, and `js/portal.js`.
- Supabase queries live in features and pages instead of services.
- The large feature files share private state, so splitting them needs a shared state module first.
- The shared `today` in `js/utils/dates.js` is computed once at page load while `js/portal.js` recalculates it, so a page left open past midnight can show a stale date.
- `css/polish.css` is 5984 lines and unsplit; it is loaded after `css/styles.css`, so rule order is behaviorally significant.
- TEMP-DEBUG lines remain in `js/core/auth.js` and `js/features/rider-jobs.js`.
