# Promo Kings System Audit

**Scope and evidence.** Read-only review of the current working tree, browser JavaScript/HTML/CSS, deployment notes, Supabase migrations and function source. The working tree already contained unrelated-to-this-audit status-board changes (`status-board.html`, `js/app.js`, `js/portal.js`, `deliveries.html`, `route-admin.html`, `css/polish.css`); those were not modified. Migration findings describe repository SQL, not the live Supabase project's applied schema, grants, policies or data. No credentials or live database access were available. Statements requiring runtime confirmation are marked **suspected**.

## 1. Executive summary

The app has a clear role/page allowlist, meaningful server-side RLS and trigger guards for its principal workflows, and server-side field/status validation. This is a static client app, however, so correctness and confidentiality still depend on the deployed policies matching the migrations. The largest verified concern is that the contact-masking view does not mask the underlying deliveries table, which is directly selectable by authenticated users whose policies permit delivery reads. A tracked OpenSSH private-key file is also present at the deployment root; its purpose and actual public deployment are unconfirmed and it should be treated as potentially exposed.

### Top 10 issues

1. **High, security:** operations roles can query raw delivery contact fields through `deliveries`, bypassing the contact-masking view (migration evidence; deployed grants/policies must be checked).
2. **High, suspected, security:** a tracked private SSH key sits in the documented GitHub Pages publishing root; verify public reachability and rotate/revoke if it is or was deployed.
3. **Medium, integrity:** a salesperson can submit an artwork change after the artwork is Done; the insert trigger can move the parent back to Change requested.
4. **Medium, integrity:** the later rider guard drops the unique active-slot index and does not restore interval/slot collision enforcement. Assignment collisions remain possible through concurrent/direct updates.
5. **Medium, functional:** production-store delivery loading is capped at 1,000; its Load more path repeats the same capped query rather than advancing.
6. **Medium, functional:** generic `?open=` links only scroll to an already-rendered row; filters can hide artwork or rider targets, and those pages do not show a not-found notice or open a View dialog.
7. **Medium, usability:** Route admin defaults to Today / unassigned / active, which can hide older, assigned, finished or declined requests; chip counts and chips are based on the loaded page rather than all matches.
8. **Medium, integrity/operations:** deactivating a rider does not automatically unassign or stop already-assigned jobs; the assigned rider may no longer be able to access or advance them.
9. **Low–Medium, performance:** unpaginated `select("*")` reads for artwork and changes grow with the full dataset; multiple screens re-fetch related data.
10. **Low–Medium, performance:** two identical 158,853-byte logo SVGs are tracked; the main app module is 244,499 bytes and the main stylesheet is 68,381 bytes (before transfer compression).

### Five highest-value speed wins

| Priority | Proposal | Expected gain | Effort / risk | Safe verification |
|---|---|---|---|---|
| 1 | Remove the duplicate logo asset from page usage and confirm it is not required by an external link. | Low–Medium, removes one 159 KB duplicate asset from repo/deployment. | Low / low. | Network panel: only one logo request; compare visual output on all pages. |
| 2 | Paginate artwork and change-history queries and request only fields each screen renders. | High as records grow; reduces payload and render work. | Medium / medium. | Compare counts, sort order and all pages of results against existing behavior. |
| 3 | Fix production-store pagination and profile-name loading so neither silently stops at 1,000. | High for users with large datasets. | Low–Medium / medium. | Seed/identify >1,000 rows and verify no duplicates/gaps across pages. |
| 4 | Avoid repeating delivery detail lookups per row; batch profile/vehicle labels and reuse safely scoped lookup data. | Medium; fewer round trips when opening many entries. | Medium / medium. | Network query count and detail parity with uncached behavior. |
| 5 | Make list refresh visibility-aware and guard overlapping notification/list requests; debounce remaining searches. | Medium; less background traffic and stale-response churn. | Low–Medium / low–medium. | Network panel with hidden tab, slow network, and rapid filter changes; ensure newest result wins. |

## 2. System map

### Pages and shared frontend resources

| Page | File | Intended use |
|---|---|---|
| Login | `index.html` | Sign-in screen |
| Home | `home.html` | Role-specific overview and latest records |
| Artworks | `sales.html`, `designer.html`, `admin.html` | Sales request entry, designer queue, admin artwork management |
| Users | `users.html` | Admin user/profile management |
| Deliveries | `deliveries.html` | Sales, production and dispatch delivery workflow |
| Production store | `production-store.html` | Production-store entry and handoff |
| Route admin | `route-admin.html` | Rider-job assignment and route queue |
| Riders | `riders.html` | Rider requests and requester-facing records |
| My jobs | `my-jobs.html` | Assigned rider jobs |
| Vehicles | `vehicles.html` | Dispatch vehicle management |
| Status board | `status-board.html` | Admin read-only delivery board |

Shared browser files: `js/app.js`, `js/portal.js`, `js/login.js`, `js/logo.js`, `js/delivery-slots.js`, `js/rider-request-slots.js`, `js/dialog-keyboard.js`; styles: `css/styles.css`, `css/polish.css`. App pages load shared CSS, Supabase JS v2 from jsDelivr and the app module; page shells also reference `config.js` as applicable. `js/app.js` imports the slot, keyboard and portal modules. There is no package manifest or automated test runner in the project root.

### Supabase schema and platform objects

The following is the **migration-source inventory**, not a claim that each object exists in production:

- **Types:** `app_role`, `artwork_status`, `change_status`. `app_role` evolves to include `salesperson`, `designer`, `admin`, `production`, `dispatch`, `route_admin`, `rider`, `production_store`, and `user`. (`supabase/migrations/20261020000000_artwork_tracker.sql:3-5`; later role additions are in migrations dated 20261024–20261027.)
- **Public tables (15):** `profiles`, `branding_sizes`, `ref_counters`, `artwork_requests`, `artwork_changes`, `user_credentials`, `audit_log`, `login_attempts`, `designer_notifications`, `deliveries`, `vehicles`, `rider_jobs`, `portal_notifications`, `portal_ref_counters`, `artwork_work_notes`.
- **Other referenced platform objects:** `auth.users` (profile foreign key), `auth.uid()` and `pgcrypto` (installed into `extensions`). The migrations do not create an object in `auth`.
- **View:** `deliveries_role_safe`, declared `security_invoker = true`; it masks contact name/number for production and dispatch in the view only (`supabase/migrations/20261028000001_mask_delivery_contacts_for_operations.sql:1-37`).
- **Storage:** no Storage bucket creation or bucket reference was found in the reviewed migrations/app code.
- **Realtime publication:** migrations add `designer_notifications`, `portal_notifications`, `deliveries`, `rider_jobs`, and `artwork_work_notes` to `supabase_realtime`. Realtime exposure depends on the deployed Supabase publication and policies.

**Database functions created/replaced by migrations:** `current_role`, `is_admin`, `next_ref_no`, `set_artwork_ref`, `prepare_artwork_change`, `touch_artwork`, `set_artwork_completion`, `guard_artwork_update`, `after_artwork_change_insert`, `guard_artwork_change_update`, `after_artwork_change_update`, `after_artwork_change_insert_count`, `complete_open_artwork_changes`, `store_user_credential`, `admin_view_password`, `login_attempt_state`, `record_login_attempt`, `has_nonempty_text_lines`, `validate_artwork_detail_lines`, `has_valid_branding_details`, `sync_artwork_branding_legacy_fields`, `guard_artwork_branding_and_preference`, `notify_preferred_designer`, `clear_assignment_notification_on_start`, `guard_artwork_completed_at`, `set_artwork_work_note_author`, `notify_artwork_work_note`, `valid_delivery_items`, `next_portal_ref`, `prepare_delivery_insert`, `guard_delivery_update`, `prepare_rider_job_insert`, `guard_rider_job_update`, `notify_delivery_events`, `notify_rider_job_events`, `has_route_admin_access`, `has_production_store_access`, `valid_production_delivery_items`, `delivery_goods_status`, `sync_delivery_goods_status`, `notify_delivery_goods_status`, `admin_delete_delivery`, `delivery_so_numbers_search_text`. The browser also invokes the `user-admin` Edge Function; Edge Functions are `login` and `user-admin`. `admin_delete_user` is called by the Edge Function but is not present in the timestamped migration set reviewed; its implementation is expected in separately provisioned/manual SQL and must be confirmed in the live project.

**Triggers created by migrations:** `artwork_ref_before_insert`, `artwork_change_before_insert`, `artwork_touch_before_update`, `artwork_completion_before_update`, `artwork_guard_before_update`, `artwork_change_after_insert`, `artwork_change_guard_before_update`, `artwork_change_after_update`, `artwork_change_count_after_insert`, `artwork_done_after_update`, `artwork_detail_lines_before_insert`, `artwork_detail_lines_before_update`, `artwork_branding_sync_before_insert`, `artwork_branding_sync_before_update`, `artwork_branding_update_guard`, `artwork_preferred_designer_notification_after_insert`, `artwork_preferred_designer_notification_after_update`, `artwork_assignment_notification_clear_after_update`, `artwork_a_completed_at_guard_before_update`, `deliveries_prepare_before_insert`, `deliveries_guard_before_update`, `rider_jobs_prepare_before_insert`, `rider_jobs_guard_before_update`, `deliveries_notify_after_change`, `rider_jobs_notify_after_change`, `deliveries_goods_status_before_insert`, `deliveries_goods_status_before_update`, `deliveries_goods_status_notification_after_change`, `artwork_work_note_set_author`, `artwork_work_note_notify_participant`.

**RLS policy inventory from migrations** (names may be dropped/replaced by later migrations; verify deployed state):

- `profiles`: `Authenticated users can read profiles`; `Admins manage profiles`.
- `branding_sizes`: `Authenticated users read branding sizes`; `Admins insert branding sizes`; `Admins update branding sizes`; `Admins manage branding options`.
- `artwork_requests`: `Sales read own artwork`; `Designers read assigned and Any artwork`; `Designers read all artwork`; `Admins read all artwork`; `Sales insert own artwork`; `Sales edit own requested artwork`; `Designers claim or update visible work`; `Admins manage artwork`; `Admins delete artwork`.
- `artwork_changes`: `Sales read own changes`; `Designers read visible changes`; `Admins read changes`; `Sales add own changes`; `Designers complete visible changes`; `Admins manage changes`.
- `designer_notifications`: `Designers read their assignment notifications`.
- `deliveries`: `delivery role read`; `sales create own delivery`; `production mark ready`; `dispatch update ready delivery`; `admin manage deliveries`; `production store read own deliveries`; `salesperson read assigned deliveries`; `production store create assigned delivery`; `assigned salesperson complete delivery`; `hide pending handoffs from delivery operations`; `production store edit own pending deliveries`; `production store read delivery workflow`; `production store edit own deliveries`.
- `vehicles`: `dispatch read vehicles`; `dispatch manage vehicles`.
- `rider_jobs`: `rider jobs visible by role`; `sales create own rider job`; `route admin assign rider job`; `rider update own assigned job`; `admin manage rider jobs`; `rider request access read own jobs`; `rider request access create own jobs`.
- `portal_notifications`: `users read own portal notifications`; `users mark own portal notifications read`.
- `artwork_work_notes`: `Work note participants read notes`; `Work note participants add notes`; `Admins manage work notes`.
- RLS is enabled on all 15 created public tables. `user_credentials`, `audit_log`, `ref_counters`, `login_attempts`, and `portal_ref_counters` intentionally have no end-user policies in migration source and have ordinary-client access revoked. `auth.users` is Supabase-managed and outside this application-table inventory.

### Roles, intended permissions and page reach

Page reach is a client-side allowlist in `js/portal.js:1-90`; actual data access also depends on RLS.

| Role / access flag | Pages/actions represented in app |
|---|---|
| `salesperson` | Home; create/edit own requested artwork and request changes; create deliveries and complete assigned production-store handoffs; request rider jobs; own artwork/delivery/rider records. |
| `designer` | Home and Designer artwork queue; claim/start work, complete assigned work, handle change requests and exchange work notes. |
| `production` | Home and Deliveries; mark eligible delivery requests Ready. |
| `production_store` or `production_store_access` | Home and Production store; create/maintain production-store handoffs. |
| `dispatch` | Home, Deliveries and Vehicles; pack/dispatch eligible deliveries, set transport/vehicle, mark delivered, manage vehicles where authorized. |
| `route_admin` or `route_admin_access` | Home, Route admin and Riders; assign active riders/time slots or decline rider requests. |
| `rider` | Home and My jobs; start and finish assigned jobs. |
| `user` or `rider_request_access` | Riders page to request/see rider jobs; `user` is redirected to Riders at login. |
| `admin` | Home, artwork administration, Users, Deliveries, Route admin, Vehicles, Status board; broad administrative edits/deletes. Admin is excluded from My jobs. |

Navigation adds Riders, Route admin, Production store and Status board based on role/access flags. `status-board.html` is explicitly admin-only in `js/portal.js:50-90` and is rechecked in `js/app.js:2895-2900`. This is UI control, not a substitute for RLS.

### End-to-end workflows

- **Artwork:** salesperson creates a `Requested` artwork with required details and needed date → designer claims/starts as `In progress` → salesperson can add `open` changes, placing the artwork in `Change requested`; designer completes changes → designer marks artwork `Done`. Admin can edit/delete. DB triggers and RLS guard most designer/sales transitions and record completion; see `20261020000000_artwork_tracker.sql:246-455,581-621` and `20261023000001_queue_visibility_and_completed_at.sql:21-64`.
- **Delivery:** production store creates a `pending_details` handoff with item/goods data and an assigned active salesperson → salesperson completes required contact/date/time details and submits (`requested`) when goods are Ready → production changes `Not ready` to `Ready` → dispatch records `dispatched_at`/Packed, selects transport and vehicle if Company, then marks `Delivered`. The app uses `goods_status`, `production_status`, `dispatch_status`, handoff status and timestamps; guards/checks are in `20261027000002_production_store_delivery_handoff.sql:25-121`, `20261028000000_delivery_goods_status_handoff.sql:5-66`, and `20261030000001_production_store_visibility.sql:25-121`.
- **Rider/route:** requester creates `Not started` job → route admin assigns an active rider and one-hour slot (`Started`) or declines with a reason (`Declined`) → assigned rider moves `Started` → `In progress` → `Finished`. Rider DB guard and timestamp consistency check are in `20261026000000_password_reminders_and_live_portal.sql:15-99`. Later SQL removes the prior active-slot unique index; see finding F4.
- **Notifications:** database triggers enqueue portal notifications for delivery events, rider-job events/assignment, designer preference/assignment events and artwork work notes. Recipients are derived from affected salesperson/designer/rider; event keys are unique to prevent duplicate event rows. The browser fetches latest 50 newest notifications and separately counts unread, marks individual/related records read, and refreshes on realtime, visibility and a 30-second timer (`js/portal.js:327-399,459-503`). Rider assignments use a blocking acknowledgment dialog.

### Data flow

```text
Browser pages (role allowlist + Supabase anon key)
      ├── Supabase Auth ── session/profile lookup
      ├── PostgREST ── tables/views + RLS ── PostgreSQL constraints/triggers
      │       ├── artwork_requests / changes / work notes
      │       ├── deliveries / vehicles
      │       ├── rider_jobs
      │       └── profiles / notifications
      ├── Realtime publication ── page refresh/subscription callbacks
      └── Edge Functions: login (throttle/profile lookup) and user-admin
              └── service-role operations held server-side
```

## 3. Bug and missed-logic findings

| ID | Severity | Area/Page | Role affected | What happens | Steps to reproduce or code evidence | Why it matters | Recommended fix (words only) |
|---|---|---|---|---|---|---|---|
| F1 | Medium | Artwork / database | Salesperson, designer | A salesperson can insert a change request for an already Done artwork; the after-insert trigger sets the parent status to Change requested. | Submit a change for own completed request. Insert policy and trigger do not require unfinished parent: `supabase/migrations/20261020000000_artwork_tracker.sql:344-362,607-611`. | Reopens completed work and makes status/history inconsistent with intended lifecycle. | Reject change inserts when the parent is Done; keep the lifecycle rule in the database, not just the form. |
| F2 | Medium | Production store / Deliveries | Production store, salesperson, admin | Production-store query returns at most 1,000 newest rows; its “Load more” path does not advance the result window. | Inspect/load >1,000 store records; query is capped and load-more repeats it: `js/app.js:3499-3503,3512-3522,3530-3532,4131`. | Older entries become unreachable in this UI and repeated loading can mislead operators. | Use explicit range pagination with stable ordering and append/deduplicate rows. |
| F3 | Medium | `?open=` deep links | All non-admin roles with artwork/rider pages | Generic deep-link handling scrolls only to a currently rendered row. Page filters may omit the target; no friendly not-found state or View popup is opened. | Open a filtered-out artwork/rider ID using `?open=<id>`; generic handler: `js/app.js:2308-2317`; sales and route render filters: `js/app.js:1224-1230,4659-4688`. | Notifications/bookmarks can appear broken; users may be unable to find the intended record. Delivery pages have a specialized path, unlike these pages. | Make target-page handlers load/override filters for the ID, select the correct tab, open the existing detail dialog, then clean the URL; show a safe not-found message. |
| F4 | Medium | Route admin / rider assignment | Route admin, riders | The database no longer enforces the earlier unique active rider-slot constraint. The remaining partial unique index covers only one `In progress` job per rider, not duplicate `Started` assignments or overlapping slots. | Later migration drops the unique slot index (`20261026000000_password_reminders_and_live_portal.sql:35-55`); earlier guard/index are in `20261025000000_route_admin_access.sql:60-70,101-103`; current index in `20261024000000_deliveries_riders_portal.sql:111-113`. UI performs a warning query, not a hard block: `js/app.js:4580-4593,4610-4618`. | Two route admins or direct/concurrent requests can assign conflicting jobs. | Restore race-safe server-side slot/overlap enforcement, with a constraint or serialized DB check appropriate to the scheduling rules. |
| F5 | Medium | Route admin | Route admin | Default date/status/rider filters can hide legitimate records; chips/counts derive from a loaded 20-row page, not necessarily every server match. | Defaults and filter query path: `js/app.js:4445-4540`; page range and count: `js/app.js:4542-4556`; chips/rendered-row counts: `js/app.js:4659-4700`. | Users may interpret a partial count as a system-wide count or miss assigned/older/completed work. | Make the default and active filter state conspicuous, label counts as filtered/page totals, and base global chips on server-side counts or the full filtered result. |
| F6 | Medium | Riders / user lifecycle | Route admin, rider | A rider can be deactivated after assignment; migration guards check active status when assigning but do not auto-unassign existing jobs or prevent rider deactivation with jobs. | Assignment checks active rider: `20261026000000_password_reminders_and_live_portal.sql:60-75`; profile FK and no deactivation cleanup: `20261024000000_deliveries_riders_portal.sql:54`; user active edits: `js/app.js:2160-2172`. | Work can remain assigned to an account unable to log in and have no clear forward path. | Prevent deactivation while active jobs exist or atomically reassign/unassign them with an audit trail. |
| F7 | Low–Medium | Artwork screens | Salesperson, designer, admin | Artwork and artwork-change collection reads are unpaginated and use `select("*")`; nested changes and work notes are fetched for the loaded artwork set. | `js/app.js:956-979,1489,1578-1588`. | Payload, memory and render cost increase with record history; broad selection also transfers unused columns. | Select only required fields and paginate the artwork/change collections while preserving full-history access. |
| F8 | Low–Medium | Vehicles / Status board | Dispatch, admin | Vehicle list is capped at 200, active options at 100; status board fetches up to 1,000 deliveries and profiles without pagination. | `js/app.js:2860,4234-4237` and agent query trace `js/app.js:3500-3503`. | Large installations may silently omit records/options; board stage counts can represent only loaded records. | Paginate where lists may grow; explicitly surface truncation or use verified aggregate queries for board counts. |
| F9 | Low | Notifications | Rider | Assignment IDs are marked “shown” before acknowledgment; closing clears pending assignments even if marking read fails. Still-unread assignment notifications are suppressed for the tab session. | `js/portal.js:323-356,420-434`; reproduction: force read-update failure, dismiss dialog, wait for refresh. | Rider may miss an assignment prompt until a new session or another navigation. | Only mark as shown after successful acknowledgment/read update, or requeue failed acknowledgments. |
| F10 | Low–Medium | Delivery detail loading | Admin, dispatch, production | Opening records can issue a profile lookup and a separate vehicle lookup; this is an N+1-style path when many rows/details are opened. | `js/app.js:3960-3980`. | Adds avoidable latency and request volume. | Batch related names/vehicle data or maintain a correctly scoped lookup cache with invalidation on realtime updates. |

## 4. Security findings

| ID | Severity | Area/Page | Role affected | What happens | Steps to reproduce or code evidence | Why it matters | Recommended fix (words only) |
|---|---|---|---|---|---|---|---|
| S1 | High | Deliveries data access | Production, dispatch; potentially other delivery readers | Contact masking exists only in `deliveries_role_safe`; authenticated users are granted base-table SELECT and role-read policy permits operations roles to read deliveries. RLS is row-level, not column masking, so the raw contact columns may be selected directly. | `supabase/migrations/20261024000000_deliveries_riders_portal.sql:496-501,570`; view masking: `supabase/migrations/20261028000001_mask_delivery_contacts_for_operations.sql:1-37`. Verify deployed grants/policies before asserting production exposure. | Contact names/numbers are personal data; the view alone does not enforce confidentiality. | Revoke unnecessary base-table column access and expose only a least-privilege view/RPC; verify grants, RLS and PostgREST schema exposure in the live project. |
| S2 | High, **suspected exposure** | Repository / deployment | All users if public deployment contains it | A tracked root file named `ssh key` is classified as an OpenSSH private key. Deployment notes say GitHub Pages publishes from the repository root. Actual key purpose and whether GitHub Pages serves this path are not established. | `git ls-files` includes `ssh key`; `file` reports OpenSSH private key; `DEPLOY.md:39-43` documents root deployment. Do not fetch or reproduce key material. | If downloadable, the private key may grant access to an unknown system; its presence in history also persists after removal. | Identify the key owner/purpose without exposing it, revoke/rotate it immediately if valid, remove it from tracked history using the repository’s incident process, and test the deployed URL for exposure. |
| S3 | Medium | Rider assignment integrity | Route admin, riders | DB-side active-slot uniqueness was removed; concurrent or direct API assignment can bypass the UI warning. | `supabase/migrations/20261026000000_password_reminders_and_live_portal.sql:35-55`; UI warning only: `js/app.js:4580-4593`. | Conflicting route assignments undermine operational integrity. | Reinstate a transactional database-side collision rule; test simultaneous assignments. |
| S4 | Low–Medium, **suspected hardening gap** | SQL SECURITY DEFINER functions | Authenticated/anonymous callers depending on effective ACLs | A source review found no explicit revoke of PUBLIC execute on most created functions; PostgreSQL defaults commonly grant execute to PUBLIC unless altered by default privileges. Current effective ACLs were not queried. | Compare explicit revokes/grants in `20261020000000_artwork_tracker.sql:459-516,624-638`, `20261024000000_deliveries_riders_portal.sql:570-578`, and later function migrations. **Need live `has_function_privilege`/ACL audit to confirm.** | If sensitive SECURITY DEFINER functions are publicly executable, unauthorized callers may invoke them subject to their internal checks. | Audit effective function ACLs in the deployed database; revoke PUBLIC/anon execute from all privileged functions and grant only intended roles. |
| S5 | Low–Medium, **suspected hardening gap** | Artwork work-note triggers | Database owners/operators | Work-note trigger functions use `SECURITY DEFINER SET search_path = public`, unlike many functions that use an empty search path. Exploitability depends on schema CREATE privileges and deployment settings, which were not inspected. | `supabase/migrations/20261030000000_artwork_work_notes.sql:56-96`. | Unsafe name resolution can undermine definer-function isolation if an untrusted role can create shadow objects in the search path. | Confirm schema privileges and pin the function search path to trusted schemas/qualified objects. |

### Security checks that did not produce confirmed findings

- The browser uses a Supabase anon/publishable key in `config.js`, not a service-role key. Privileged service keys are read from Edge Function environment variables (`supabase/functions/login/index.ts:33`; `supabase/functions/user-admin/index.ts:39`). Do not treat the public anon key as secret; RLS is the security boundary.
- `user-admin` has gateway JWT verification configured, while `login` has `verify_jwt = false` in `supabase/config.toml:1-4`; this is not by itself proof of unauthenticated login bypass. The login function implements its own user/lockout path. Confirm function-level behavior in deployed configuration.
- Most dynamic display strings examined are escaped before insertion; no reproducible stored-XSS issue was established in this source-only pass. A full input-by-input browser/XSS test was not performed.
- No Storage bucket was found in migrations, so bucket access policies were not applicable to the reviewed source set.

## 5. Performance report

### Current costs and query inventory

The tables below enumerate the browser data access patterns found. Common refreshes use realtime and/or polling; exact request counts depend on role, page and user action. These are source-traced, not measured against production.

| Page / feature | Data/API requests and behavior |
|---|---|
| Login | `profiles(role,active)` by auth user ID (`js/login.js:68`); login Edge Function checks lockout via `login_attempt_state`, reads profile by username, and records/reset attempts through RPCs (`supabase/functions/login/index.ts:33-64`). |
| Every authenticated page | `profiles.select("*").eq("id", session.user.id)` during bootstrap (`js/app.js:2275-2277`); role/active is rechecked at page load, not continuously during an open page. |
| Home | Role-specific tables `artwork_requests`, `deliveries`, `rider_jobs`, `vehicles`, selected summary columns, newest-first, limited to 20 (`js/portal.js:29-35,216-218,292-305`). Separate `portal_notifications` latest 50 ordered by created time and exact unread count; updates by ID/related ID; realtime plus 25/30-second polling (`js/portal.js:327-399,459-503`). |
| Sales / Designer / Admin artworks | `artwork_requests.select("*").order("sr")`; `artwork_changes.select("*")` by artwork IDs or request ID, ordered by requested date; notes select named fields for request IDs ordered by creation; designer notification unread query. Writes insert/update artwork/change/work-note rows; admin can delete. No pagination on artwork/change collections (`js/app.js:956-979,1085-1095,1441-1478,1489-1490,1567-1588,1688-1690,1894-1923`). |
| Admin Users | `profiles` named fields ordered by full name, profile update by ID, and `user-admin` Edge Function calls for create/delete/reset/view password/password change (`js/app.js:915,950-951,2034,2080,2145-2172,2227-2240`). |
| Deliveries / Production store | Main delivery list selects `deliverySelect` fields from table or role-safe view, applies status/date/salesperson/search filters, order and exact count, range of 20; production-store path selects newest SR and limits 1,000. Other queries load salesperson/profile names, pending handoff rows and individual record details; vehicle lookup may occur per detail. Writes insert/update, plus `admin_delete_delivery` RPC (`js/app.js:2323-2324,3287-3324,3474-3510,3500-3503,3916,3960-3980,4021-4044`; RPC `3874`). |
| Status board | `deliveries` and `profiles(id,full_name)` reads capped at 1,000; client computes stages/counts and refreshes every 30 seconds, skipping background-tab polls (`js/app.js:2857-2862,2958-2965`). Counts are only as complete as the fetched rows. |
| Vehicles | Vehicle list named fields ordered and capped at 200; active options named fields capped at 100; profile name lookups; insert/update active toggle (`js/app.js:3539-3542,4234-4237,4262-4289`). |
| Riders / Route admin / My jobs | Named rider-job fields with role, creator/assigned rider, date, salesperson, status and search filters; route admin exact count; order and range 20. Separate exact-count active-job and rider-slot queries; `profiles` for riders/requesters; rider job inserts/updates. A route-salesperson option scan uses 1,000-row ranges (`js/app.js:4409-4418,4477-4498,4542-4578,4610-4618,4832-4838,4857-4861,4914-4915,4973`). |

**Query quality observations:** two `select("*")` reads in the artwork flow transfer broad rows; profile bootstrap also selects `*`. Several list caps have no visible truncation warning. Delivery/rider list requests generally have a page range; Home has a 20-row limit; vehicles, artwork and production-store lists do not have complete pagination.

### Assets, rendering, polling and optimization plan

- **Measured source sizes:** `js/app.js` 244,499 bytes; `js/portal.js` 26,862; `css/polish.css` 68,381; `css/styles.css` 6,763. Two logo SVGs are byte-identical by SHA-256 and each 158,853 bytes. Compression/transfer size and deployed caching headers were not measured.
- **Requests:** page shells reference two stylesheets, favicon/logo, config, the Supabase JS CDN script and ES module(s); app modules import additional local JS. This produces repeated static requests across page navigation, though browser cache behavior was not measured. No build/minification pipeline was found.
- **Rendering:** lists/cards are reconstructed through `innerHTML`; tables are not virtualized. Most row content is escaped, but no browser test confirmed long-data rendering or all injection paths. `js/app.js` has 20-row paging for delivery/rider lists; artwork and Home list rendering are bounded differently.
- **Polling/realtime:** Status board polls at 30 seconds and skips hidden tabs (`js/app.js:2958-2965`). Home has a refresh lock and skips hidden tabs (`js/portal.js:170-184`). Notification polling is every 30 seconds, also realtime and visibility triggered; there is no shared in-flight lock across those triggers (`js/portal.js:327-328,459-477`). Delivery/rider result tokens mitigate stale responses; other list refreshes may overlap. Realtime channels are removed on pagehide for app bootstrap, but deployment/network cleanup was not stress-tested (`js/app.js:2290-2296`).
- **Recommended order:** (1) remove duplicate logo use; (2) fix capped pagination; (3) paginate and narrow artwork/change queries; (4) add safe batching/cache for lookup names; (5) add in-flight/visibility guards to notification and remaining list refreshes. Gains and verification are listed in the executive summary. For indexes/views/RPCs, first capture production `EXPLAIN (ANALYZE, BUFFERS)` and request counts; do not add indexes based only on source inspection.
- **Index candidates to evaluate, not automatic changes:** `rider_jobs(created_by, scheduled_date, created_at DESC)` for route-admin creator/date filters; `deliveries(salesperson_id, handoff_status, created_at DESC)` for salesperson handoff lists; and an index supporting the actual production-store query ordering/filter. Existing migration indexes include artwork creator/designer/status, delivery production/dispatch status and creator, rider creator/assignee/status, unread notifications, active vehicles, and work-note request/time. Confirm selectivity and query plans before adding indexes.
- **Data aggregation:** status-board stage counts are computed client-side after loading up to 1,000 deliveries; a read-only aggregate view/RPC could return complete counts, but must preserve the same stage mapping and access policy and be validated against row-level results. Do not introduce it without live query/data verification.

## 6. Data and schema recommendations (proposals only)

1. Enforce rider-slot collision rules transactionally in PostgreSQL; determine whether slots are exact-hour or interval-overlap rules and handle both `Started` and relevant active states.
2. Add a DB guard preventing artwork change insertion when parent status is Done.
3. Constrain delivery contact-field visibility at the base-table privilege boundary; explicitly test raw REST `deliveries` selection for each role.
4. Define a safe deactivation policy for riders/designers/salespeople with active assignments (block, reassign, or preserve a service actor), and log the decision.
5. Confirm uniqueness/format constraints against live data for DL/SR/SO references; migration source already defines unique generated sequence/reference fields and formatting checks, but the live schema/data must be checked.
6. Evaluate composite indexes only after query-plan analysis; candidates and filters are listed in §5. Avoid redundant indexes that duplicate existing prefixes.
7. If board counts require all rows, consider a policy-aware database aggregate/view or paged query and reconcile its output with actual delivery rows; preserve stage boundaries and date semantics.
8. Confirm all migrations are applied in order and compare live policy/function ACLs with repository source. The source includes manual/admin operations beyond timestamped migrations; do not assume the migration directory is the complete deployed schema.

## 7. Suggested regression checklist

Run with representative test accounts for each role and seeded records. Verify both visible UI and direct authenticated API/RLS behavior.

- **Login/session:** valid/invalid credentials, lockout and recovery; inactive user; logout; 24-hour expiry; role/access flag change while a tab is open; multiple tabs/concurrent sessions; refresh/back/deep link while logged out.
- **Salesperson:** create/edit own artwork, cannot edit another user’s request or a non-Requested item; valid and invalid artwork details/date; add revisions before/after Done; create delivery and rider request; complete only assigned, ready handoff; check notifications and read state.
- **Designer:** claim eligible/unassigned work; concurrent claim; start, request revisions, complete; reject backward/skipped updates; work notes and notifications to the correct participant; access to unassigned/Done work per intended policy.
- **Production store / salesperson handoff:** create pending-details entry, assign active salesperson, preserve goods status; salesperson completes only when Ready; verify incomplete/invalid items fail at DB and UI; verify >1,000 records paginate without loss.
- **Production / dispatch:** Ready transition only when eligible; pack before transport/vehicle/delivered; company transport requires active vehicle; client transport behavior; no changes after Delivered; concurrent updates; compare status board counts and source list.
- **Route admin / rider / requester:** create empty/valid/invalid requests, bad dates/times, overlap assignment, two simultaneous assignments, decline reason; rider can start then finish only assigned job; inactive rider with outstanding assignment; unauthorized roles cannot read/update others’ records.
- **Admin / Users / Vehicles:** create/edit/deactivate users, reset/change/view password, delete user and delivery; verify audit/cleanup consequences; manage vehicles and assigned vehicle references; status board stays admin-only.
- **Filters and navigation:** Today/week/month boundaries in Africa/Nairobi and UTC; zero-result states; search special characters/quotes/emoji/HTML; filter combinations and pagination; counts equal complete matching rows; each `?open=` target overrides filters, scrolls/highlights, opens the detail UI, clears query afterward, handles missing IDs and works in a new tab.
- **Notifications:** trigger each event once, confirm exact recipients and no duplicate event, read/unread/badge consistency, update failure/retry, realtime reconnect, polling/realtime overlap, rider assignment dialog dismissal.
- **Accessibility/content:** long strings and null optional fields; keyboard-only dialogs/forms; labels and focus; submit double-click/slow network; no false-success state after Supabase errors; phone/laptop viewport checks.
- **Security:** for every table and function, test anon/authenticated role grants, RLS row/column exposure, SECURITY DEFINER ACLs and direct REST access; attempt XSS payloads as data in every rendered field; verify no service-role key or private key is deployed.

## 8. Open questions and assumptions

1. Which Supabase project is live, and can its schema, RLS policies, grants, function ACLs, realtime publication and data be compared with the checked-in migrations?
2. Are all timestamped migrations applied in filename order? What manual SQL or dashboard changes exist, including the implementation of `admin_delete_user`?
3. Is the GitHub Pages site public and publishing the repository root? What is the tracked `ssh key` for, who owns it, and has it ever been deployed or used? Treat it as compromised until answered.
4. Should production/dispatch be allowed to see delivery contact names/numbers through any API, or is masking an explicit requirement?
5. What is the intended rider collision policy: exact same one-hour slot only, any overlapping interval, or one active job regardless of slot?
6. Should changing a rider’s active flag be blocked while assigned jobs remain, or should those jobs be reassigned?
7. What are the authoritative rules for modifying an artwork after Done and for accepting a late change request?
8. Are the current page defaults (especially Route admin Today/unassigned/active) intentional? Should board counts include all history or only the selected date range?
9. Is there a production dataset above the observed 1,000/200 row caps, and what are expected record volumes?
10. Are HTML/script strings ever intentionally accepted as rich content, or must every field remain plain text?
11. What caching/compression headers and CDN caching are configured on the deployed GitHub Pages domain?

## Verification actually performed

| Check | Result | Limits |
|---|---|---|
| `node --check` on all seven `js/*.js` browser files | **PASS** | Syntax only, not runtime behavior. |
| Python HTML parser on all 13 root HTML shells | **PASS** | Parse only, not accessibility or browser behavior. |
| Direct logged-out navigation to Status board locally | **PASS**: redirected to sign-in | Confirms this local path only; not role-by-role enforcement or deployed behavior. |
| Authenticated workflows, RLS, triggers, notifications, and live counts | **NOT TESTED** | No database credentials or test fixtures were available. |
| Browser tests by role, viewport, keyboard, XSS, invalid transitions, races | **NOT TESTED** | No automated test suite or authenticated test session. |
| GitHub Pages response headers, deploy contents, and key URL reachability | **NOT TESTED** | Deployment access unavailable. |
| Supabase request counts/transfer timings/EXPLAIN plans | **NOT TESTED** | Performance conclusions are static estimates. |
