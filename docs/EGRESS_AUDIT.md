# Supabase egress audit (read-only)

## Scope and estimate notes

Searched all 20 repository `.js` and `.html` files for Supabase/PostgREST,
Auth, RPC, Realtime, timers, visibility/focus/network events and selection/
pagination patterns. Direct data access is in `js/app.js`, `js/portal.js`, and
`js/login.js`; `config.js` creates the clients. The other scripts and static
HTML pages do not issue Supabase data requests.

The estimates below are per active browser tab. A 30-second interval is
120 cycles/hour; a 25-second interval is 144 cycles/hour. Table sizes and
row counts supplied with the request are storage/scan evidence, not measured
HTTP response sizes. Byte estimates are rough, uncompressed response proxies;
they are not additive across tabs and need browser/network or Supabase
per-endpoint telemetry to refine. Number of all-day tabs/users is unknown.

## Phase 1 — Supabase calls, subscriptions and refresh triggers

| file | line | table | what it does | trigger | est. calls per user per hour | est. rows and bytes per call | risk |
|---|---:|---|---|---|---:|---|---|
| `js/app.js` | 2760, 2769 | Auth, `profiles` | Each authenticated page gets the session and selects the current profile with `select("*").eq("id", …).maybeSingle()`. One profile row; the `profiles` RLS lookup is DB work, not a large egress response. | Mount | 1 each | 1 row; a few KB | Low |
| `js/app.js` | 2447; 2519 | Auth | `getUser()` during page bootstrap; `refreshSession()` only after a password change. | Mount / user action | 1 / rare | No table rows; small Auth response | Low |
| `js/login.js` | 49, 68, 93 | Auth, `profiles`, login Function | Reads session and one profile during login redirect; login form calls the login Edge Function. | Login only | 0 for an already-open page | 1 profile row; small | Low |
| `js/app.js` | 1027 | `profiles` | `loadUsers()` retrieves the full profile list (named columns, no limit) for Sales, Designer and Admin pages. | Page mount | 1 | All profiles; table is 248 KB on disk, response smaller | Low |
| `js/app.js` | 1034 | `artwork_requests` | `loadArtworks()` retrieves every artwork row, all columns, ordered by SR; no filter or pagination. | Sales/Designer/Admin mount; 30s refresh; matching Realtime events; after writes | About 120 per visible page, plus events | About 104 rows; 280 KB table-size proxy | High |
| `js/app.js` | 1038 | `artwork_changes` | `loadArtworks()` then retrieves `select("*")` for all IDs returned above; no status filter or pagination. | Same refresh as `loadArtworks()` | About 120 per visible page, plus events | All matching history; 112 KB table-size proxy | High |
| `js/app.js` | 1054 | `artwork_work_notes` | Sales/Designer loads all notes for the full loaded artwork ID set, including message text; no pagination. | Sales/Designer mount; 30s refresh; matching Realtime events | About 120 per visible page, plus events | All matching notes; 80 KB table-size proxy | High |
| `js/app.js` | 2045 | `designer_notifications` | Reads all unread assignment notification IDs for Designer; no explicit recipient or limit (access depends on RLS). | Designer mount and every `refreshArtworks()` | About 120, plus events | All unread rows; 128 KB table-size proxy | Med |
| `js/app.js` | 2056, 2071 | `artwork_changes` | `changesFor()` fetches all open changes for the loaded artwork IDs; called by both Designer tallies and Designer render. A separate summary query fetches change counts/dates for the same IDs. | Designer mount, each 30s refresh, Realtime event, period change | Up to 3 calls per refresh (about 360), plus events | Up to the loaded open/all changes; 112 KB table-size proxy per broad result | High |
| `js/app.js` | 1967 | `artwork_changes` | `showHistory()` selects all columns for one artwork’s history when History is opened. | User opens history | User-driven | One artwork’s changes; variable | Low |
| `js/app.js` | 2200–2234 | Artwork tables above | `refreshArtworks()` reloads artworks and changes, Designer unread notifications, and Sales/Designer work notes; then it launches page rendering/tally logic. It has no refresh in-flight guard, but defers refresh while a dialog is open. | 30s timer; Realtime; after writes; dialog close | 120 base refreshes/hour, plus event/write bursts | See component reads above | High |
| `js/app.js` | 2185–2197, 2256 | Artwork tables | Sales/Designer subscribe to artwork requests, changes and work notes (Designer also subscribes to designer notifications); each event calls the broad `refreshArtworks()`. Admin subscribes to artwork requests and does the same. Channels are created once per page init, not in render. | Realtime (unfiltered table events) | Event-dependent | Repeats the full refresh set above | High |
| `js/app.js` | 3935–3941 | `deliveries`, `profiles`, `artwork_requests`, `rider_jobs` | Status board loads four datasets in parallel. Deliveries are capped at 1,000 (currently all ~109); profiles at 1,000; artwork requests use `select("*")` without a limit; rider jobs have named columns but no filter or range. | Initial refresh and every 30s; Realtime event | 4 × 120 = 480 calls, plus event refreshes | About 109 deliveries, all profiles, 104 artworks and 88 rider jobs; roughly 0.5–1 MB combined storage-size proxy per cycle | High |
| `js/app.js` | 4033–4038 | `deliveries`, `artwork_requests`, `rider_jobs` | Status board has three unfiltered table subscriptions; every event schedules a full four-query status-board refresh after 500ms. | Realtime | Event-dependent | Full status-board payload above | High |
| `js/app.js` | 4081–4092 | Status-board timer | 30s interval skips while hidden; visibility return refreshes immediately. A `statusBoardLoading` guard queues one follow-up refresh; pagehide clears timer/listener and removes its channels. | Interval / visibility | 120 refresh cycles when visible | Four reads per cycle | High |
| `js/app.js` | 4962–4972, 5044–5084 | `deliveries` / role-safe view | `fetchAllDeliveryRows()` reads all rows with the full `deliverySelect` projection (including item JSON), paging in ranges of 1,000. `loadDeliveries()` does this on mount; `refreshDeliveryRows()` repeats it to compare the whole list. | Mount; 30s interval; visibility; not on delivery Realtime events | 1 call per cycle at current row count: about 120/hour per Deliveries/Production store tab | About 109 rows; 416 KB table-size proxy, with `items`; likely ~100–450 KB response | High |
| `js/app.js` | 6280–6286 | `deliveries`, `vehicles` | Shared 30s refresh callback performs the full delivery read above; Dispatch/Admin also reload active vehicles each cycle. Delivery Realtime separately fetches only changed IDs in batches of 100. | Interval / visibility / Realtime by ID | 120 full delivery reads plus up to 120 small vehicle reads | Delivery: about 109 rows; vehicles: at most 100 | High |
| `js/app.js` | 6256–6271 | `deliveries` | One unfiltered deliveries channel per page; events are batched for 250ms and patched by ID rather than reloading the whole table. Channel removed on pagehide via global cleanup. | Realtime | Event-dependent | One row per changed ID, batched by 100 | Low |
| `js/app.js` | 6273–6278 | `vehicles` | Dispatch/Admin subscribes to all vehicle changes; every event reloads up to 100 active vehicles. | Realtime | Event-dependent | At most 100 short rows | Low |
| `js/app.js` | 6179–6192, 1417–1433 | Delivery activity counts | Delivery page requests 4 or 5 `count: exact, head: true` queries through `activityCount`; no row payload. Repeated on period changes and selected status-refresh events. Report rows are fetched only when a tile is opened. | Mount / period change / occasional status change / report click | 4–5 count calls per refresh; report call is user-driven | Count: 0 rows; report: matching rows, paged by 1,000 | Low |
| `js/app.js` | 4806, 4866, 4884 | `profiles` | Salesperson options are fetched for production entry, or for IDs represented by the delivery rows; the latter can repeat after detected delivery changes. | Page mount / changed deliveries | Usually 0–1 per refresh, conditional | Relevant salesperson profiles only | Low |
| `js/app.js` | 5087, 6290 | `vehicles` | Active vehicle options (limit 100) and Vehicles page list (limit 200) use named columns. Vehicles page list reloads on mount, 30s timer, and Realtime. | Mount / 30s / Realtime / after vehicle writes | Vehicles page: about 120 calls/hour; delivery options: up to 120/hour for Dispatch/Admin | At most 100 or 200 short rows | Med |
| `js/app.js` | 5733–5745 | `profiles`, `vehicles` | Opening a delivery detail does one salesperson profile lookup and, if needed, one vehicle lookup not already cached in `vehicleRows`. | User opens detail | User-driven; 0 when cached | 1 row per query | Low |
| `js/app.js` | 4315, 4348, 5684 | Deliveries / role-safe view | Duplicate conflict details, conflict summary and a deep link each read one delivery by ID/SR. | Conflict or deep-link interaction | User-driven | 1 row each | Low |
| `js/app.js` | 4369, 4478, 5641, 5990, 6011 | RPCs | `check_so_items` runs during duplicate checks/save; `admin_delete_delivery` on delete; client suggestion RPC is debounced 250ms; client defaults RPC runs on client-name change. | Form input / save / delete | User-driven; suggestions depend on typing | Small result sets; variable | Low |
| `js/app.js` | 4640–4655, 5789, 6318, 6343–6344 | `deliveries`, `vehicles` | Delivery inserts/updates return ID/reference; delivery updates patch local rows by ID. Vehicle writes update one row but then reload the vehicle list. | User write | User-driven | One returned row or no row; vehicle list reload up to 200 | Low |
| `js/app.js` | 491, 779, 1162, 1919–1921, 1951, 2172, 2378, 2406, 2661 | `artwork_requests`, `artwork_changes`, `artwork_work_notes`, `profiles` | Artwork line/branding edits, request create/update, change/note inserts, Designer/Admin updates/deletes and profile updates. Several success paths call `refreshArtworks()`, re-fetching broad collections as described above. | User writes | User-driven | Usually one row; some responses return only ID/reference | Med egress after write due to subsequent broad refresh |
| `js/app.js` | 992 | `user-admin` Function | Admin helper invokes the user-admin Edge Function for admin actions. | User action | User-driven | Small action response | Low |
| `js/app.js` | 6465–6470, 6940–6942 | `profiles` | Rider list loads rider profiles; Route admin also loads active requester profiles. | Riders/Route admin mount | 1 each | Relevant profile rows; no explicit cap | Low |
| `js/app.js` | 6535–6550 | `rider_jobs`, `profiles` | Route admin reads every `created_by` in rider_jobs using pages of 1,000 to build Salesperson options, then fetches matching active profiles. This is unfiltered by date/status and runs on Route admin mount only. | Route admin mount | Usually 1 rider_jobs call at current size + 1 profiles call | About 88 IDs; very small response | Med |
| `js/app.js` | 6612–6648 | `rider_jobs` | Riders/Route admin/My jobs fetch a page of 20 rows; Route admin/My jobs also request exact count. Rider loads an additional head-only In progress count on every list load. | Mount; 30s timer; filter/search; Realtime; Load more | About 120 list calls/hour; rider pages add about 120 head counts/hour | 20 rows (named columns); count returns no rows | Med |
| `js/app.js` | 7060–7063 | `rider_jobs` | Riders/Route admin uses an unfiltered channel; any rider-job event reloads the current page’s list. My jobs has its own channel filtered by `assigned_rider`. | Realtime | Event-dependent | A 20-row page (plus optional count) | Med |
| `js/app.js` | 7066, 7265 | `rider_jobs` | Deep-link fallback reads one job by ID when it was not in the first page. | Deep-link only | User-driven | 1 row | Low |
| `js/app.js` | 6410–6425, 6915–6920 | `rider_jobs` | Rider request insert and status/assignment update. Success paths reload the current 20-row page. | User write | User-driven | One written row; then one paged list read | Low |
| `js/app.js` | 1417–1433, 6720–6737 | `rider_jobs` | Route activity tiles fetch matching rows for each of five event-date cards on mount/period change; request page uses four exact head counts. My jobs uses three exact head counts on mount/period change and loads report rows only on tile click. | Mount / period change / tile click | Route: 5 row queries per summary; Rider request: 4 count calls; My jobs: 3 count calls | Filtered period rows, paged by 1,000; counts return no rows | Med |
| `js/portal.js` | 29–34, 237–240, 318–335 | Home category tables | Home sequentially fetches each role’s categories with 20-row limits. Categories can include artwork, deliveries, rider jobs and vehicles. | Home mount and 25s refresh | 144 calls/hour per displayed category | At most 20 selected rows per category; approx. 5–80 KB, delivery items may be larger | Med |
| `js/portal.js` | 160–210 | Home category tables | One channel per unique table for the role; every event re-renders/re-fetches all category lists. A 25s timer also refreshes. Hidden tabs skip refresh; visibility return refreshes immediately. `refreshing` prevents overlap. | Realtime / 25s / visibility | 144 cycles/hour, plus event refreshes | Up to 20 rows/category/cycle | Med |
| `js/portal.js` | 364–368 | `portal_notifications` | Every authenticated page fetches the latest 50 notification rows and separately requests exact unread count (`head: true`). List query has no explicit recipient filter (relies on RLS); count is also RLS-scoped. | Mount; 30s poll; visibility; matching Realtime; bell click | 2 calls per cycle = 240/hour per open tab, plus events/click | At most 50 short rows (roughly 5–15 KB); count returns 0 rows | Med egress; High request/log volume |
| `js/portal.js` | 499–516 | `portal_notifications` | One channel filtered by recipient ID; every event invokes both reads above. Poll skips hidden tabs; visibility return refreshes immediately; pagehide clears timer/listener and removes channel. | Realtime / 30s / visibility | 120 cycles/hour | See above | Med |
| `js/portal.js` | 409, 425, 529 | `portal_notifications` | Marks one notification, related notifications, or all cached unread notifications read. Opening the bell may do an update, refresh, then a second update for newly arrived items. | User opens/reads notification | User-driven | Updates only affected IDs | Low |
| `js/app.js` | 832–850, 1641–1665, 1974–2028, 2236–2258, 6280–6286, 6374–6378, 6930–7063, 7116–7263 | Various | `startVisibleRefresh()` creates one 30s timer on each initialized page (Sales, Designer, Admin, Deliveries/Production store, Vehicles, Riders/Route admin, My jobs), skips hidden tabs and refreshes immediately on visibility return. Each timer/listener is cleared on pagehide. | Interval / visibility | 120 callbacks/hour per active page | Depends on callback; see rows above | High for full-list callbacks |
| `js/app.js` | 867 | Auth/session (no table) | 60s local session-expiry check; signs out only when the stored session duration has elapsed. | Interval | 60 checks/hour | No data rows | Low |
| `js/app.js` | 2742 | Auth | `onAuthStateChange` redirects only on `SIGNED_OUT`; it does not reload data for `TOKEN_REFRESHED` or repeated `SIGNED_IN`. | Auth event | Event-dependent | No data rows | Low |
| `js/app.js` | 4081–4092; `js/portal.js` 202–209, 505–516 | Timers/cleanup | Status board uses 30s; Home 25s; notification polling 30s. All skip hidden tabs and clean up timers/listeners/channels on pagehide; each has a visibility-return refresh with no age/TTL check. | Interval / visibility | As above | As above | Med |

### Other timer and event checks

- No `requestAnimationFrame` data loop, `hashchange`, `online`, or focus listener
  was found that fetches Supabase data. `visibilitychange` handlers are listed
  above; they refresh immediately on return, even if a recent interval fetch
  just completed.
- `setTimeout` calls for status-board movement, dialog/assignment UI, toast
  removal and form reset do not fetch. Data-related timeouts are the 500ms
  status-board Realtime debounce, 250ms delivery Realtime batch, and 250ms
  delivery-client suggestion debounce/RPC.
- App bootstrap has one `onAuthStateChange` handler and one page initialization.
  Realtime channels are not created from render functions. Global pagehide
  cleanup removes all app channels; feature handlers also remove their own
  channels, so teardown may be requested twice but subscriptions do not stack
  during normal static-page navigation.
- No `select()` with no arguments or embedded `users(*)`/join query was found.
  The `select("*")` reads are at `app.js:1034,1038,1967,2056,2769,3939`.
- `designer_notifications` is queried by Designer only. The supplied 453 scans
  indicate it is not a leading egress source. Profile RLS scan counts are
  database work and are explicitly outside this task; no policies were changed.

## Phase 2 — Rank and proposed fixes (approval required)

Rank reflects per-tab request rate × approximate response size, adjusted
qualitatively for how many roles may leave a page open. Tab-hours by role are
not available, so the first three may reorder in actual organization usage.

| rank | likely source | why it ranks here |
|---:|---|---|
| 1 | Deliveries full-list fallback refresh (`app.js:4962,5044,6280`) | 120 whole-list reads/hour per visible deliveries/production-store tab; item JSON is included. The supplied 39,294 delivery scans averaging ~109 rows closely match this query. Multiple operational roles can keep these tabs open. |
| 2 | Artwork refresh (`app.js:1034–1054,2056–2071,2200`) | Full artwork and change history are repeatedly fetched every 30s; Sales/Designer also reload all notes, and Designer makes repeated change queries. Every related Realtime event and several writes invoke the same broad refresh. |
| 3 | Status board (`app.js:3935–3941,4033,4081`) | Four broad reads every 30s (480 calls/hour), including unfiltered artwork and rider-job collections. It may be only one or a few tabs, but has the highest broad-read volume per tab. |
| 4 | Home (`portal.js:160–210,237–240`) | 25s refresh refetches up to 20 rows per category; role-specific Home pages may query several tables and can remain open on office PCs. |
| 5 | Notification bell (`portal.js:346–368,499–516`) | Two requests every 30s on every authenticated page and additional reads on events/visibility/bell open. Returned list is capped at 50, so payload is smaller than the full-list sources, but the request/log volume is high and appears consistent with notification scan stats. |

### Fix plan and estimated savings

These are broad working-day estimates, not additive. They assume the recurring
reads account for most of the reported 150–300 MB/day and use the provided
table sizes as response proxies. Actual savings depend on active-tab hours,
RLS-visible rows and serialized response sizes.

| priority | proposed change after approval | file(s) | estimated effect |
|---:|---|---|---|
| 1 | Keep delivery Realtime-by-ID updates; increase full-list reconciliation from 30s to 5m, and only refresh on visibility return when the cached rows are stale. Keep all currently visible rows and UI behavior. Avoid vehicle/profile reloads unless their source data changed. | `js/app.js` | ~90% fewer fallback full-list reads; rough organization estimate 20–90 MB per working day. |
| 2 | Keep notification unread badge as a head-only exact count; poll at 60s or more with a TTL check. Fetch the 50-row list when opened and update the in-memory list from the existing recipient-filtered Realtime payload rather than re-fetching the list on every poll/event. Preserve rider assignment notices and toast behavior. | `js/portal.js` | Removes most background list payloads; rough estimate 1–8 MB/day and a larger reduction in request/log volume. |
| 3 | Project only status-board fields actually rendered; keep all rows because the board shows the full active backlog. Increase full reconciliation to 2–5m; retain current Realtime refresh behavior initially. | `js/app.js` | Potentially 10–70 MB/day, mostly from fewer broad refresh cycles; projection savings depend on JSON field sizes. |
| 4 | Increase artwork fallback refresh to 2–5m; coalesce artwork Realtime bursts; reuse the already-loaded change data for Designer tallies/render instead of issuing repeated `changesFor()` queries. Project artwork/change columns to those used by each page. Preserve full visible records and history. | `js/app.js` | Potentially 20–100 MB/day across active Sales/Designer/Admin tabs; Designer benefits most from deduplicating repeated changes reads. |
| 5 | Increase Home fallback refresh from 25s to 60s and use a visibility TTL so a recently completed refresh is not immediately repeated. Keep existing 20-row display and Realtime channels. | `js/portal.js` | ~58% fewer timer refresh cycles; rough estimate 2–20 MB/day depending on Home tab-hours. |
| 6 | Change the shared 30s refresh helper to be page-configurable (or configure only remaining rider/vehicle pages), refresh at 60s or more, and suppress duplicate visibility refreshes within the TTL. Fix the Vehicle page’s `bindPeriodSummary()` registration inside its submit handler so repeated vehicle saves do not stack period-change listeners/count queries. | `js/app.js` | Rough estimate 2–20 MB/day; also removes listener-stack amplification. |
| 7 | After each user write, prefer returned row data/local state where behavior permits. Current delivery writes already patch by ID; artwork writes trigger a full collection refresh, and vehicle writes reload the list. Do not cap currently unpaginated lists without explicit approval. | `js/app.js` | Additional but unquantified savings; write frequency is lower than polling. |

Combined, I estimate a **rough 70–220 MB/working-day reduction** if the broad
polling reads account for most of the measured baseline. A residual around
30–100 MB/day is plausible; staying below 50 MB/day cannot be guaranteed from
source alone without tab-hour and response-byte measurements. If the measured
result remains high, the next safe step is browser Network byte totals by
endpoint and Supabase request logs, not adding arbitrary row limits that
change the visible lists.

No code, RLS policy, database object, or data was changed. No SQL was run or
created at this approval gate. After approval, the four requested SQL review
files can be prepared under `sql/egress-review/`; they will remain unexecuted.
