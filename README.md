
# Workspace

A static, role-based app for artwork requests, deliveries, and riders. The front end is plain HTML, CSS, and JavaScript, hosted on GitHub Pages; Supabase provides Auth, Postgres/RLS, Realtime, and the two Edge Functions. There is no application server.

## Assumptions

- Staff sign in with a username and password; nobody needs to provide or receive an email address. Supabase Auth internally requires an identifier, so the Edge Function maps each username to a non-deliverable `<lowercase username>@promokings.local` alias. It is not shown in the UI and is not used to send mail.
- An unassigned designer (`Any`) means any designer may claim that request. A specific assignment can only be claimed by that designer.
- The migration provisions the initial `IT` admin account in Supabase Auth. The first authenticated session must change the initial password.
- Dates and reporting periods use `Africa/Nairobi`.
- Password viewing is retained because it was requested. Passwords are encrypted with a Supabase Edge Function secret and are only decrypted after an admin check; each view is audited.
## Run locally

The front end is static, but login and app data still need a configured Supabase project and deployed Edge Functions.

1. Complete the **Deploy Supabase** steps below.
2. Set the Supabase project URL and anon/public key in `config.js`.
3. From the project folder, start a local static web server. With Node.js installed, run:

   ```sh
   npx --yes http-server . -p 8080 -c-1
   ```

   Or, in VS Code, use the **Live Server** extension and choose **Open with Live Server** on `index.html`.
4. Open [http://localhost:8080](http://localhost:8080) (or the address shown by Live Server) and sign in with a username and password.

Do not open `index.html` as a `file://` URL; browser module loading and Supabase requests need an HTTP origin. For a complete offline/local Supabase stack, install Docker and the Supabase CLI, then use `supabase start`; deploy/serve the included Edge Functions locally and point `config.js` at the local Supabase API URL and anon key printed by the CLI. The remote-project setup above is simpler for initial testing.

## Project contents

- `index.html`, `home.html`, `sales.html`, `designer.html`, `admin.html`, `users.html`, `deliveries.html`, `riders.html`, `route-admin.html`, `vehicles.html`, `my-jobs.html`: sign-in and role workspaces. Shared role-aware navigation and Home behavior are in `js/portal.js`; page access is checked against the authenticated profile and data access is also restricted by RLS.
- `config.js`: public Supabase project URL and anon key only.
- `js/`: login and dashboard behavior.
- `supabase/migrations/20261020000000_artwork_tracker.sql`: schema, atomic reference allocation, triggers, RLS, seed sizes, initial admin, and Realtime publication setup.
- `supabase/migrations/20261021000000_branding_size_free_text.sql`, `20261022000000_request_detail_lines.sql`, and `20261023000000_branding_details_and_assignment_notifications.sql`: existing incremental artwork schema updates; run in order.
- `supabase/migrations/20261023000001_queue_visibility_and_completed_at.sql`: designer queue read visibility and system-managed artwork completion timestamps.
- `supabase/migrations/20261024000000_deliveries_riders_portal.sql`: additional roles, protected delivery and rider workflows, vehicle registry, portal notifications, and independent DL/RJ reference counters.
- `supabase/migrations/20261025000000_route_admin_access.sql`: additive route-admin access and protected rider assignment permissions.
- `supabase/migrations/20261026000000_password_reminders_and_live_portal.sql`: temporary-password profile state, idempotent Realtime publication setup, route-admin decline workflow and notifications, and non-blocking rider-slot conflict warnings.
- `supabase/migrations/20261027000000_delivery_address_free_text.sql`: allow non-empty free-text delivery item addresses without a format or length restriction.
- `supabase/functions/login/`: username login and 5-failure/15-minute lockout.
- `supabase/functions/user-admin/`: user creation, reset, password view/audit, and first-login password change.

## Deploy Supabase

1. Create a Supabase project on the free tier and save its project URL and **anon/public** key from **Project Settings → API**.
2. Open **SQL Editor**, paste and run `supabase/migrations/20261020000000_artwork_tracker.sql`. It creates the `IT` admin account and branding-size options. Change the seeded admin password in Supabase Authentication before enabling public access; never publish the bootstrap credential. The database stores only the Auth hash; the reversible encrypted password copy is saved after the admin completes the required first-login password change.
3. In **SQL Editor**, run `supabase/migrations/20261021000000_branding_size_free_text.sql` to keep existing branding-size values while removing the lookup constraint. The `branding_sizes` table is retained.
4. In **SQL Editor**, run `supabase/migrations/20261022000000_request_detail_lines.sql` to convert the product, branding mode, and logo-position fields into arrays while preserving existing text as one-line arrays.
5. In **SQL Editor**, run `supabase/migrations/20261023000000_branding_details_and_assignment_notifications.sql` to consolidate branding details into structured lines, preserve old values, record designer preference separately from claims, and enable assignment notifications.
6. In **SQL Editor**, run `supabase/migrations/20261023000001_queue_visibility_and_completed_at.sql` to make the designer queue visible to all designers and track completion time.
7. In **SQL Editor**, run `supabase/migrations/20261024000000_deliveries_riders_portal.sql` to add the delivery and rider workspaces, roles, RLS, triggers, and notifications.
8. In **SQL Editor**, run `supabase/migrations/20261025000000_route_admin_access.sql` to allow route-admin access to be added to another user role and prevent duplicate active rider time slots.
9. In **SQL Editor**, paste and run `supabase/migrations/20261026000000_password_reminders_and_live_portal.sql` to persist temporary-password reminders, enable portal table Realtime, and support rider-request declines. It can be pasted again safely. Then run `supabase/migrations/20261027000000_delivery_address_free_text.sql` to allow non-empty delivery addresses in free-text format.
10. Install the Supabase CLI, authenticate, and link this project:

   ```sh
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

11. Generate a strong encryption key locally (do not add it to the repository), then set the Edge Function secret:

   ```sh
   openssl rand -base64 48
   supabase secrets set CREDENTIAL_ENCRYPTION_KEY='paste-the-generated-value-here'
   ```

   Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Do not copy the service-role key into `config.js`, a GitHub repository, or any browser code.

12. Deploy the changed user-administration function from the repository root:

   ```sh
   supabase functions deploy user-admin --no-verify-jwt
   ```

   The login function is public by necessity; it validates usernames, applies the database-backed lockout, and returns only a Supabase Auth session. `user-admin` validates the caller's JWT and active admin profile before any privileged operation.
13. In Supabase **Authentication**, open **Providers** or **Sign In / Up** (the exact submenu may vary by dashboard version), then set **Password requirements / Minimum password length** to **8**.
14. No email address or email verification is required from staff. The app creates Auth users as already confirmed with an internal `.local` alias; it does not send authentication emails.

Route-admin access is an additional permission managed from the admin **Users** tab; it does not replace the user's existing role. The UI only improves navigation and convenience—Supabase RLS and database triggers enforce access.

## Deploy to GitHub Pages

1. In `config.js`, replace `YOUR-PROJECT-REF` and `YOUR_SUPABASE_ANON_KEY` with the Supabase project URL and anon/public key. The anon key is public and is safe here only because all database access is protected by RLS. Never paste a service-role key into this file.
   The header/login logo is loaded from `images/promo-kings-logo.svg`; keep that relative path and file in the repository for GitHub Pages.
2. Push the project files to the root of a GitHub repository. For a new repository, from this project directory:

   ```sh
   git init
   git add .
   git commit -m "Build Promo Kings artwork tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USER/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   No build step is required; relative paths are used for GitHub Pages subpaths.
3. In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select the branch and `/ (root)`, then save.
4. Visit `https://YOUR_GITHUB_USER.github.io/YOUR_REPOSITORY/` and sign in with:

   - Username: `IT` (case-insensitive)
   - Use the bootstrap password supplied privately during setup; change it before public access.

5. Complete the forced password change. The new password is encrypted in `user_credentials`; only an active admin can request a view, and every view is written to `audit_log`.
6. Add designer and salesperson accounts from **User management**. Give each user their temporary password securely; every new or reset account must change it at first login.

### Password-viewing security trade-off

Supabase Auth cannot reveal an existing password. This app stores an encrypted copy so an administrator can view it as explicitly requested. That is a security trade-off compared with password reset alone: keep the encryption key only in Supabase Edge Function secrets, restrict admin accounts, review the audit log, and prefer resetting passwords over viewing them. An administrator who can invoke the Edge Function and access the encryption secret can decrypt saved copies.

## Manual verification checklist

### Sign-in and access control

- [ ] Sign in as `IT`; verify the forced password-change dialog blocks the dashboard until a new password is saved.
- [ ] Sign out, then verify an incorrect password shows a friendly error. Five failed attempts for a username should lock login for 15 minutes.
- [ ] Sign in as each role and verify it lands on its own page.
- [ ] Sign in, close and reopen the browser, and verify the session remains active for 24 hours. Change `loginAt` in local storage to a timestamp 25 hours ago, reload, and verify the app signs out and asks you to log in again.
- [ ] Sign out and sign in as a different user in the same browser; verify the active Supabase session and 24-hour timestamp now belong only to the new account.
- [ ] While signed in, manually open the other two role URLs; verify the app redirects to the correct role page.
- [ ] Sign out and attempt a direct dashboard URL; verify it redirects to login.
- [ ] Deactivate a user as admin and verify the inactive account cannot sign in or use RLS-protected data.
- [ ] Verify the company logo appears on login and all dashboards at laptop and phone widths.
- [ ] Change the forced password, create a user, and reset a password: confirm seven characters are rejected with a clear message and eight are accepted.
- [ ] On login, sales, designer, and admin pages at 360px, 768px, and desktop width, verify navigation collapses to its menu button where appropriate, controls remain usable, and the page has no horizontal scrolling.
- [ ] At phone width, verify stat cards use two columns (one column at very narrow widths), forms use one column, controls are at least 44px tall, dialogs fit and scroll internally, and tables scroll within their own cards.

### Salesperson

- [ ] Create a request with all required fields; verify server-generated reference format and increasing monthly sequence.
- [ ] In the Branding popup, add and remove lines; verify the seven mode choices appear in the requested order, save changes, and discard edits. Repeat while editing a `Requested` item.
- [ ] Verify logo, mode, Pantone code, size, and position appear in the sales table, designer view-only popup, admin table/edit view, and CSV.
- [ ] Verify existing branding mode, logo/position, Pantone, and size values remain visible after migration. The previous schema combined logo and position in one text value, so it is retained as Position rather than split automatically.
- [ ] Verify the salesperson's designer preference is shown in the sales table, designer queue, admin view, and CSV.
- [ ] Try a past needed date and missing required fields; verify the form blocks submission.
- [ ] Edit a `Requested` item, then verify Edit is unavailable after a designer starts it.
- [ ] Submit two changes for one request; verify the history lists both and open changes reach the designer.
- [ ] Verify tally periods and live status updates after the designer marks artwork done.

### Designer

- [ ] Verify the queue contains only assigned work and `Any` work; other designers' assigned jobs are not visible.
- [ ] Start an `Any` request in two browser sessions and verify only one designer can claim it.
- [ ] Save notes/final-file URL, mark the artwork done, and verify the salesperson sees the update without refreshing.
- [ ] Try to change product or branding details and the preferred designer as a designer through the browser console/API; confirm the database rejects the update. Verify the designer branding popup has no edit controls.
- [ ] Select a specific designer and verify a new-assignment alert appears for that designer until the request is started; verify `Any` appears in designer views and is claimable by one designer.
- [ ] Verify a change banner and notification count remain until the designer presses Done.

### Admin

- [ ] Filter artwork by salesperson, designer, status, category, date range, ref number, and client; export the filtered rows to CSV.
- [ ] Edit and delete an artwork item; verify change history is removed with a deleted item.
- [ ] Add a user, change roles, deactivate/reactivate, reset a password, and verify each new/reset password requires a first-login change.
- [ ] View a user's password and verify a `password_viewed` record appears in `audit_log`.
