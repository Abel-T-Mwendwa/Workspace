-- ============================================================
-- STAGING ONLY - NEVER RUN IN PRODUCTION.
-- Fixture accounts all use the staging-only password: Stage2Test!2026
-- Re-runnable: fixture users, deliveries, and release logs use stable IDs.
-- ============================================================

begin;

with fixture_users (
  id, username, full_name, role_name,
  production_store_access, production_access, dispatch_access,
  route_admin_access, rider_request_access
) as (
  values
    ('d2000000-0000-4000-8000-000000000001'::uuid, 'stage2_admin', 'Stage 2 Admin', 'admin', true, true, true, true, true),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 'stage2_store', 'Stage 2 Production Store', 'production_store', true, false, false, false, false),
    ('d2000000-0000-4000-8000-000000000003'::uuid, 'stage2_dispatch', 'Stage 2 Dispatch', 'dispatch', false, false, true, false, false),
    ('d2000000-0000-4000-8000-000000000004'::uuid, 'stage2_sales', 'Stage 2 Salesperson', 'salesperson', false, false, false, false, false),
    ('d2000000-0000-4000-8000-000000000005'::uuid, 'stage2_production', 'Stage 2 Read-only Production', 'production', false, true, false, false, false)
)
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  id,
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  username || '@promokings.local',
  extensions.crypt('Stage2Test!2026', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object(
    'username', username,
    'full_name', full_name,
    'role', role_name,
    'password_change_required', false
  ),
  now(),
  now(),
  '',
  '',
  '',
  ''
from fixture_users
on conflict (id) do update
set encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at,
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

with fixture_users (id, username) as (
  values
    ('d2000000-0000-4000-8000-000000000001'::uuid, 'stage2_admin'),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 'stage2_store'),
    ('d2000000-0000-4000-8000-000000000003'::uuid, 'stage2_dispatch'),
    ('d2000000-0000-4000-8000-000000000004'::uuid, 'stage2_sales'),
    ('d2000000-0000-4000-8000-000000000005'::uuid, 'stage2_production')
)
insert into auth.identities (
  provider_id, user_id, identity_data, provider, created_at, updated_at
)
select
  id::text,
  id,
  jsonb_build_object('sub', id::text, 'email', username || '@promokings.local'),
  'email',
  now(),
  now()
from fixture_users
on conflict do nothing;

with fixture_profiles (
  id, username, full_name, role_name,
  production_store_access, production_access, dispatch_access,
  route_admin_access, rider_request_access
) as (
  values
    ('d2000000-0000-4000-8000-000000000001'::uuid, 'stage2_admin', 'Stage 2 Admin', 'admin', true, true, true, true, true),
    ('d2000000-0000-4000-8000-000000000002'::uuid, 'stage2_store', 'Stage 2 Production Store', 'production_store', true, false, false, false, false),
    ('d2000000-0000-4000-8000-000000000003'::uuid, 'stage2_dispatch', 'Stage 2 Dispatch', 'dispatch', false, false, true, false, false),
    ('d2000000-0000-4000-8000-000000000004'::uuid, 'stage2_sales', 'Stage 2 Salesperson', 'salesperson', false, false, false, false, false),
    ('d2000000-0000-4000-8000-000000000005'::uuid, 'stage2_production', 'Stage 2 Read-only Production', 'production', false, true, false, false, false)
)
insert into public.profiles (
  id, username, full_name, role, active,
  production_store_access, production_access, dispatch_access,
  route_admin_access, rider_request_access, password_change_required
)
select
  id, username, full_name, role_name::public.app_role, true,
  production_store_access, production_access, dispatch_access,
  route_admin_access, rider_request_access, false
from fixture_profiles
on conflict (id) do update
set username = excluded.username,
    full_name = excluded.full_name,
    role = excluded.role,
    active = excluded.active,
    production_store_access = excluded.production_store_access,
    production_access = excluded.production_access,
    dispatch_access = excluded.dispatch_access,
    route_admin_access = excluded.route_admin_access,
    rider_request_access = excluded.rider_request_access,
    password_change_required = false;

-- The insert trigger requires the caller to be the salesperson creating their own request.
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'd2000000-0000-4000-8000-000000000004',
  true
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'd2000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

insert into public.deliveries (
  id, created_by, salesperson_id, handoff_status, goods_status,
  client_name, contact_name, contact_number, delivery_date, delivery_time_any,
  items, production_status, dispatch_status, ready_at, dispatched_at,
  delivered_at, transport, vehicle_id
)
values
  (
    'e2000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client A', 'Stage 2 Contact A', '0712000001',
    current_date + 7, true,
    '[{"so_number":"STG2-NR-100","item_name":"No release single","quantity":"100","address":"Staging address A","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client B', 'Stage 2 Contact B', '0712000002',
    current_date + 7, true,
    '[{"so_number":"STG2-NR-100B","item_name":"No release sequential","quantity":"100","address":"Staging address B","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  ),
  (
    'e2000000-0000-4000-8000-000000000003',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client C', 'Stage 2 Contact C', '0712000003',
    current_date + 7, true,
    '[{"so_number":"STG2-PR-100","item_name":"Partial release single","quantity":"100","address":"Staging address C","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  ),
  (
    'e2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client D', 'Stage 2 Contact D', '0712000004',
    current_date + 7, true,
    '[{"so_number":"STG2-PR-40","item_name":"Partial release first","quantity":"40","address":"Staging address D1","goods_status":"not_ready"},{"so_number":"STG2-PR-60","item_name":"Partial release second","quantity":"60","address":"Staging address D2","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  ),
  (
    'e2000000-0000-4000-8000-000000000005',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client E', 'Stage 2 Contact E', '0712000005',
    current_date + 7, true,
    '[{"so_number":"STG2-FL-130","item_name":"Fully released single","quantity":"130","address":"Staging address E","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  ),
  (
    'e2000000-0000-4000-8000-000000000006',
    'd2000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000004',
    'requested', 'not_ready', 'Stage 2 Client F', 'Stage 2 Contact F', '0712000006',
    current_date + 7, true,
    '[{"so_number":"STG2-FL-25","item_name":"Fully released first","quantity":"25","address":"Staging address F1","goods_status":"not_ready"},{"so_number":"STG2-FL-35","item_name":"Fully released second","quantity":"35","address":"Staging address F2","goods_status":"not_ready"},{"so_number":"STG2-FL-40","item_name":"Fully released third","quantity":"40","address":"Staging address F3","goods_status":"not_ready"}]'::jsonb,
    'Not ready', 'Not delivered', null, null, null, null, null
  )
on conflict (id) do nothing;

  -- Switch to the seeded administrator to attribute these requests to the production store.
  select pg_catalog.set_config(
    'request.jwt.claim.sub',
    'd2000000-0000-4000-8000-000000000001',
    true
  );
  select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', 'd2000000-0000-4000-8000-000000000001',
      'role', 'authenticated'
    )::text,
    true
  );
  update public.deliveries
  set created_by = 'd2000000-0000-4000-8000-000000000002'
  where id in (
    'e2000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000003',
    'e2000000-0000-4000-8000-000000000004',
    'e2000000-0000-4000-8000-000000000005',
    'e2000000-0000-4000-8000-000000000006'
  )
  and created_by is distinct from 'd2000000-0000-4000-8000-000000000002';

insert into public.store_release_logs (
  id, delivery_id, item_key, qty, done_on, user_id, note
)
select
  fixture.log_id,
  item.delivery_id,
  item.item_key,
  fixture.qty,
  current_date,
  'd2000000-0000-4000-8000-000000000002',
  'Stage 2 staging fixture'
from (
  values
    ('f2000000-0000-4000-8000-000000000001'::uuid, 'e2000000-0000-4000-8000-000000000003'::uuid, 'STG2-PR-100', 60),
    ('f2000000-0000-4000-8000-000000000002'::uuid, 'e2000000-0000-4000-8000-000000000004'::uuid, 'STG2-PR-40', 15),
    ('f2000000-0000-4000-8000-000000000003'::uuid, 'e2000000-0000-4000-8000-000000000004'::uuid, 'STG2-PR-60', 20),
    ('f2000000-0000-4000-8000-000000000004'::uuid, 'e2000000-0000-4000-8000-000000000005'::uuid, 'STG2-FL-130', 130),
    ('f2000000-0000-4000-8000-000000000005'::uuid, 'e2000000-0000-4000-8000-000000000006'::uuid, 'STG2-FL-25', 25),
    ('f2000000-0000-4000-8000-000000000006'::uuid, 'e2000000-0000-4000-8000-000000000006'::uuid, 'STG2-FL-35', 35),
    ('f2000000-0000-4000-8000-000000000007'::uuid, 'e2000000-0000-4000-8000-000000000006'::uuid, 'STG2-FL-40', 40)
) as fixture(log_id, delivery_id, so_number, qty)
join public.delivery_items_expanded item
  on item.delivery_id = fixture.delivery_id
  and item.so_number = fixture.so_number
on conflict (id) do nothing;

commit;
