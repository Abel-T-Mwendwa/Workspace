begin;

create temporary table partial_test_users (
  kind text primary key,
  user_id uuid not null
) on commit drop;

insert into partial_test_users (kind, user_id)
values
  ('admin', gen_random_uuid()),
  ('store', gen_random_uuid()),
  ('dispatch', gen_random_uuid()),
  ('salesperson', gen_random_uuid()),
  ('production_read_only', gen_random_uuid());

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  u.user_id,
  'authenticated',
  'authenticated',
  'partial-test-' || u.kind || '-' || replace(u.user_id::text, '-', '') || '@example.invalid',
  '',
  now(),
  pg_catalog.jsonb_build_object('provider', 'email', 'providers', pg_catalog.jsonb_build_array('email')),
  pg_catalog.jsonb_build_object(
    'username', 'partial_test_' || u.kind || '_' || pg_catalog.left(replace(u.user_id::text, '-', ''), 8),
    'full_name', 'Partial test ' || u.kind,
    'role', case u.kind
      when 'admin' then 'admin'
      when 'store' then 'production_store'
      when 'dispatch' then 'dispatch'
      when 'salesperson' then 'salesperson'
      else 'production'
    end
  ),
  now(),
  now()
from partial_test_users u;

insert into public.profiles
  (id, username, full_name, role, active, production_store_access,
   production_access, dispatch_access)
select
  u.user_id,
  'partial_test_' || u.kind || '_' || pg_catalog.left(replace(u.user_id::text, '-', ''), 8),
  'Partial test ' || u.kind,
  case u.kind
    when 'admin' then 'admin'::public.app_role
    when 'store' then 'production_store'::public.app_role
    when 'dispatch' then 'dispatch'::public.app_role
    when 'salesperson' then 'salesperson'::public.app_role
    else 'production'::public.app_role
  end,
  true,
  u.kind = 'store',
  u.kind = 'production_read_only',
  u.kind = 'dispatch'
from partial_test_users u
on conflict (id) do update
set username = excluded.username,
    full_name = excluded.full_name,
    role = excluded.role,
    active = excluded.active,
    production_store_access = excluded.production_store_access,
    production_access = excluded.production_access,
    dispatch_access = excluded.dispatch_access;

do $block$
declare
  store_id uuid := (select user_id from partial_test_users where kind = 'store');
  salesperson_id uuid := (select user_id from partial_test_users where kind = 'salesperson');
  fixture_tag text := replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, salesperson_id, 'pending_details', 'Partial fixture 130',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-SETUP-' || fixture_tag || '-130',
        'item_name', 'Setup fixture 130',
        'address', 'Setup address 130',
        'quantity', '130',
        'goods_status', 'not_ready'
      ))),
    (store_id, salesperson_id, 'pending_details', 'Partial fixture 20',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-SETUP-' || fixture_tag || '-20',
        'item_name', 'Setup fixture 20',
        'address', 'Setup address 20',
        'quantity', '20',
        'goods_status', 'not_ready'
      ))),
    (store_id, salesperson_id, 'pending_details', 'Partial fixture 5',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-SETUP-' || fixture_tag || '-5',
        'item_name', 'Setup fixture 5',
        'address', 'Setup address 5',
        'quantity', '5',
        'goods_status', 'not_ready'
      )));
end
$block$;

create temporary table partial_test_deliveries (
  name text primary key,
  delivery_id uuid not null,
  item_key text,
  second_item_key text,
  trip_one uuid,
  trip_two uuid,
  failed_trip uuid
) on commit drop;

create or replace function pg_temp.partial_test_assert_failure(
  actor_id uuid,
  statement text,
  expected_message text
)
returns void
language plpgsql
as $function$
declare actual_message text;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', actor_id::text, true);
  begin
    execute statement;
    raise exception 'TEST_ASSERTION: expected statement to fail: %', statement;
  exception
    when others then
      get stacked diagnostics actual_message = message_text;
      if actual_message like 'TEST_ASSERTION:%' then raise; end if;
      if position(expected_message in actual_message) = 0 then
        raise exception 'Expected error containing "%", received "%".', expected_message, actual_message;
      end if;
  end;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
end
$function$;

create or replace function pg_temp.partial_test_assert_delivery_constraints(
  delivery_id uuid,
  actor_id uuid
)
returns void
language plpgsql
as $function$
declare previous_actor text := current_setting('request.jwt.claim.sub', true);
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', actor_id::text, true);
  update public.deliveries d
  set client_name = d.client_name
  where d.id = delivery_id;
  if not found then
    raise exception 'Delivery fixture % does not exist.', delivery_id;
  end if;
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    coalesce(previous_actor, ''),
    true
  );
exception
  when others then
    perform pg_catalog.set_config(
      'request.jwt.claim.sub',
      coalesce(previous_actor, ''),
      true
    );
    raise;
end
$function$;

create or replace function pg_temp.partial_test_assert_rpc_denied(
  operation text,
  actor_id uuid,
  delivery_id uuid,
  item_key text,
  trip_id uuid,
  release_id uuid
)
returns void
language plpgsql
as $function$
declare actual_message text;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', actor_id::text, true);
  begin
    case operation
      when 'release_item' then perform public.release_item(delivery_id, item_key, 1, null);
      when 'receive_item' then perform public.receive_item(delivery_id, item_key, 1, null);
      when 'pack_to_trip' then
        perform public.pack_to_trip(delivery_id, item_key, 1, null, 'Test vehicle', null, null);
      when 'deliver_trip' then
        perform public.deliver_trip(trip_id, current_date, 'Test address', null, null);
      when 'fail_trip' then perform public.fail_trip(trip_id, 'Test failure');
      when 'void_entry' then
        perform public.void_entry('store_release_logs', release_id, 'Test void');
      when 'close_with_balance' then
        perform public.close_with_balance(delivery_id, 'Test close');
      when 'change_job_card_total' then
        perform public.change_job_card_total(delivery_id, item_key, 99);
      else raise exception 'Unknown RPC in test helper: %', operation;
    end case;
    raise exception 'TEST_ASSERTION: % unexpectedly accepted an unauthorized caller.', operation;
  exception
    when others then
      get stacked diagnostics actual_message = message_text;
      if actual_message like 'TEST_ASSERTION:%' then raise; end if;
      if position('access is required' in actual_message) = 0
        and position('administrator access is required' in actual_message) = 0 then
        raise exception 'Expected access denial from %, received "%".', operation, actual_message;
      end if;
  end;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
end
$function$;

do $block$
declare
  store_id uuid := (select user_id from partial_test_users where kind = 'store');
  sales_id uuid := (select user_id from partial_test_users where kind = 'salesperson');
  admin_id uuid := (select user_id from partial_test_users where kind = 'admin');
  keys_id uuid;
  key_one text;
  key_two text;
  main_id uuid;
  main_key text;
  removal_id uuid;
  removal_key_one text;
  removal_key_two text;
  invalid_id uuid;
  invalid_key text;
  ready_id uuid;
  delivered_id uuid;
  pending_id uuid;
  fixture_tag text := replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);

  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Partial logic test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag,
          'item_name', 'Test item 130',
          'address', 'Test address',
          'quantity', '130',
          'goods_status', 'not_ready'
        ),
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-B',
          'item_name', 'Test item B',
          'address', 'Test address B',
          'quantity', '10',
          'goods_status', 'not_ready'
        )
      )
    )
    returning id into keys_id;
  select item_key into key_one from public.delivery_items_expanded
      where delivery_id = keys_id and item_name = 'Test item 130';
  select item_key into key_two from public.delivery_items_expanded
      where delivery_id = keys_id and item_name = 'Test item B';
  if key_one is null or key_two is null or key_one = key_two then
    raise exception 'Item keys were not assigned uniquely on insert.';
  end if;
  if (select job_card_total from public.delivery_items_expanded
      where delivery_id = keys_id and item_key = key_one) <> 130 then
    raise exception 'String quantity "130" did not safely cast to the job card total.';
  end if;
  update public.deliveries d
  set items = (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_set(line.item - 'item_key', '{address}',
        pg_catalog.to_jsonb((line.item ->> 'address') || ' changed'), true)
      order by line.ordinality
    )
    from pg_catalog.jsonb_array_elements(d.items) with ordinality as line(item, ordinality)
  )
  where d.id = keys_id;
  if not exists (
    select 1 from public.delivery_items_expanded
    where delivery_id = keys_id and item_key = key_one
      and item_name = 'Test item 130'
  ) or not exists (
    select 1 from public.delivery_items_expanded
    where delivery_id = keys_id and item_key = key_two
      and item_name = 'Test item B'
  ) then
    raise exception 'Item keys were not matched by position when omitted at an unchanged line count.';
  end if;
  update public.deliveries d
  set items = (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_set(line.item, '{address}',
        pg_catalog.to_jsonb((line.item ->> 'address') || ' reordered'), true)
      order by line.ordinality desc
    )
    from pg_catalog.jsonb_array_elements(d.items) with ordinality as line(item, ordinality)
  )
  where d.id = keys_id;
  if not exists (
    select 1 from public.delivery_items_expanded
    where delivery_id = keys_id and item_key = key_one
      and item_name = 'Test item 130'
  ) or not exists (
    select 1 from public.delivery_items_expanded
    where delivery_id = keys_id and item_key = key_two
      and item_name = 'Test item B'
  ) then
    raise exception 'Item keys changed when keyed lines were reordered.';
  end if;

  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Partial logic main test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-MAIN',
          'item_name', 'Main item',
          'address', 'Main address',
          'quantity', '100',
          'goods_status', 'not_ready'
        )
      )
    )
  returning id into main_id;
  select item_key into main_key from public.delivery_items_expanded
    where delivery_id = main_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  update public.deliveries
  set handoff_status = 'requested',
      client_name = 'Partial logic main test',
      contact_name = 'Test contact',
      contact_number = '5550100',
      delivery_date = current_date
  where id = main_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);

  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Untouched removal test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-C',
          'item_name', 'Keep item',
          'address', 'Test address',
          'quantity', '5',
          'goods_status', 'not_ready'
        ),
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-D',
          'item_name', 'Remove item',
          'address', 'Test address',
          'quantity', '7',
          'goods_status', 'not_ready'
        )
      )
    )
  returning id into removal_id;
  select item_key into removal_key_one from public.delivery_items_expanded
    where delivery_id = removal_id and item_name = 'Keep item';
  select item_key into removal_key_two from public.delivery_items_expanded
    where delivery_id = removal_id and item_name = 'Remove item';
  update public.deliveries d
  set items = pg_catalog.jsonb_build_array(
    (select line.item from pg_catalog.jsonb_array_elements(d.items) as line(item)
     where line.item ->> 'item_key' = removal_key_one)
  )
  where d.id = removal_id;
  if (select count(*) from public.delivery_items_expanded where delivery_id = removal_id) <> 1
    or exists (select 1 from public.delivery_items_expanded
      where delivery_id = removal_id and item_key = removal_key_two) then
    raise exception 'Removing an untouched item line did not work.';
  end if;

  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Invalid quantity update test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-INVALID',
          'item_name', 'Invalid quantity item',
          'address', 'Test address',
          'quantity', '130',
          'goods_status', 'not_ready'
        )
      )
    )
  returning id into invalid_id;
  select item_key into invalid_key from public.delivery_items_expanded
    where delivery_id = invalid_id;

  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Ready backfill test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-READY',
          'item_name', 'Ready legacy item',
          'address', 'Ready address',
          'quantity', '20',
          'goods_status', 'ready'
        )
      )
    )
  returning id into ready_id;
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Delivered backfill test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-DELIVERED',
          'item_name', 'Delivered legacy item',
          'address', 'Delivered address',
          'quantity', '30',
          'goods_status', 'ready'
        )
      )
    )
  returning id into delivered_id;
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Not started backfill test',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'so_number', 'SO-PARTIAL-' || fixture_tag || '-PENDING',
          'item_name', 'Not started legacy item',
          'address', 'Pending address',
          'quantity', '40',
          'goods_status', 'not_ready'
        )
      )
    )
  returning id into pending_id;

  insert into partial_test_deliveries (name, delivery_id, item_key, second_item_key)
  values
    ('keys', keys_id, key_one, key_two),
    ('main', main_id, main_key, null),
    ('removal', removal_id, removal_key_one, removal_key_two),
    ('invalid', invalid_id, invalid_key, null),
    ('legacy_ready', ready_id, (select item_key from public.delivery_items_expanded where delivery_id = ready_id), null),
    ('legacy_delivered', delivered_id, (select item_key from public.delivery_items_expanded where delivery_id = delivered_id), null),
    ('legacy_pending', pending_id, (select item_key from public.delivery_items_expanded where delivery_id = pending_id), null);
end
$block$;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (select user_id::text from partial_test_users where kind = 'store'),
  true
);

select pg_temp.partial_test_assert_failure(
  (select user_id from partial_test_users where kind = 'store'),
  format(
    'insert into public.deliveries (created_by, salesperson_id, handoff_status, client_name, items) values (%L::uuid, %L::uuid, %L, %L, %L::jsonb)',
    (select user_id from partial_test_users where kind = 'store'),
    (select user_id from partial_test_users where kind = 'salesperson'),
    'pending_details', 'Blank quantity',
    '[{"so_number":"SO-PARTIAL-BLANK","item_name":"Blank","address":"A","quantity":"","goods_status":"not_ready"}]'
  ),
  'positive whole number'
);
select pg_temp.partial_test_assert_failure(
  (select user_id from partial_test_users where kind = 'store'),
  format(
    'insert into public.deliveries (created_by, salesperson_id, handoff_status, client_name, items) values (%L::uuid, %L::uuid, %L, %L, %L::jsonb)',
    (select user_id from partial_test_users where kind = 'store'),
    (select user_id from partial_test_users where kind = 'salesperson'),
    'pending_details', 'Nonnumeric quantity',
    '[{"so_number":"SO-PARTIAL-ABC","item_name":"ABC","address":"A","quantity":"abc","goods_status":"not_ready"}]'
  ),
  'positive whole number'
);

do $block$
declare
  invalid_delivery uuid := (select delivery_id from partial_test_deliveries where name = 'invalid');
  current_items jsonb;
begin
  select items into current_items from public.deliveries where id = invalid_delivery;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format(
      'update public.deliveries set items = %L::jsonb where id = %L::uuid',
      jsonb_set(current_items, '{0,quantity}', to_jsonb(''::text), true)::text,
      invalid_delivery
    ),
    'positive whole number'
  );
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format(
      'update public.deliveries set items = %L::jsonb where id = %L::uuid',
      jsonb_set(current_items, '{0,quantity}', to_jsonb('abc'::text), true)::text,
      invalid_delivery
    ),
    'positive whole number'
  );

  if coalesce(public.partial_safe_int(''), 0) <> 0
    or coalesce(public.partial_safe_int('abc'), 0) <> 0
    or public.partial_safe_int('130') <> 130 then
    raise exception 'Invalid quantities did not safely cast to zero, or a numeric string did not cast correctly.';
  end if;
end
$block$;

do $block$
declare
  store_id uuid := (select user_id from partial_test_users where kind = 'store');
  dispatch_id uuid := (select user_id from partial_test_users where kind = 'dispatch');
  admin_id uuid := (select user_id from partial_test_users where kind = 'admin');
  sales_id uuid := (select user_id from partial_test_users where kind = 'salesperson');
  v_delivery_id uuid;
  v_item_key text;
  v_receipt_id uuid;
  fixture_tag text := replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, items)
  values
    (store_id, sales_id, 'pending_details',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-DETAILS-' || fixture_tag,
        'item_name', 'Missing detail item',
        'address', 'Missing detail address',
        'quantity', '1',
        'goods_status', 'not_ready'
      )))
  returning id into v_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select item_key into v_item_key from public.delivery_items_expanded
  where delivery_id = v_delivery_id;

  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform pg_catalog.set_config('workspace.partial_cutover', 'on', true);
  update public.deliveries
  set handoff_status = 'requested',
      production_status = 'Ready',
      ready_at = now()
  where id = v_delivery_id;
  perform pg_catalog.set_config('workspace.partial_cutover', '', true);
  perform public.partial_run_legacy_backfill(v_delivery_id);
  perform public.partial_sync_delivery_status(v_delivery_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);

  select r.id into v_receipt_id from public.dispatch_receipt_logs r
  where r.delivery_id = v_delivery_id and r.item_key = v_item_key
    and r.voided_at is null;
  if v_receipt_id is null then
    raise exception 'Missing-detail fixture did not receive its legacy receipt backfill.';
  end if;
  perform pg_temp.partial_test_assert_failure(
    dispatch_id,
    format(
      'select public.void_entry(%L, %L::uuid, %L)',
      'dispatch_receipt_logs', v_receipt_id, 'Test missing-details void'
    ),
    'Cannot set production status to Not ready until required delivery details are complete'
  );
  perform pg_temp.partial_test_assert_delivery_constraints(v_delivery_id, admin_id);
  if not exists (
    select 1 from public.dispatch_receipt_logs r
    where r.id = v_receipt_id and r.voided_at is null
  ) or (select d.production_status from public.deliveries d
        where d.id = v_delivery_id) <> 'Ready' then
    raise exception 'Incomplete delivery details did not safely block the receipt void.';
  end if;
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'main');
  v_item_key text := (select item_key from partial_test_deliveries where name = 'main');
begin
  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Production store' then
    raise exception 'An unstarted request was not in Production store.';
  end if;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format('select public.release_item(%L::uuid, %L, 101, null)', v_delivery_id, v_item_key),
    'exceeds the job card balance'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.release_item(v_delivery_id, v_item_key, 60, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Production' then
    raise exception 'A released, unreceived request was not in Production.';
  end if;
  if (select p.released from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 60 then
    raise exception 'Release of 60 was not recorded.';
  end if;
  if (select p.in_production from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 60 then
    raise exception 'in_production is not released minus received after the first release.';
  end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.release_item(v_delivery_id, v_item_key, 40, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if (select p.released from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 100 then
    raise exception 'Two releases of 60 and 40 did not total 100.';
  end if;
  if (select p.goods_status from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Ready' then
    raise exception 'A fully released 100-unit request was not Ready.';
  end if;
  if (select p.in_production from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 100 then
    raise exception 'in_production is not released minus received after full release.';
  end if;
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'keys');
  v_key_one text := (select item_key from partial_test_deliveries where name = 'keys');
  v_key_two text := (select second_item_key from partial_test_deliveries where name = 'keys');
  v_items jsonb;
begin
  select d.items into v_items from public.deliveries d where d.id = v_delivery_id;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format(
      'update public.deliveries set items = %L::jsonb where id = %L::uuid',
      pg_catalog.jsonb_build_array(
        (select line.item - 'item_key'
         from pg_catalog.jsonb_array_elements(v_items) as line(item)
         where line.item ->> 'item_key' = v_key_two)
      )::text,
      v_delivery_id
    ),
    'send item_key for every remaining or existing line'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.release_item(v_delivery_id, v_key_one, 5, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format(
      'update public.deliveries set items = %L::jsonb where id = %L::uuid',
      pg_catalog.jsonb_build_array(
        (select line.item
         from pg_catalog.jsonb_array_elements(v_items) as line(item)
         where line.item ->> 'item_key' = v_key_two)
      )::text,
      v_delivery_id
    ),
    'ledger history cannot be removed'
  );
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'main');
  v_item_key text := (select item_key from partial_test_deliveries where name = 'main');
  v_trip_one uuid;
  v_trip_two uuid;
  v_failed_trip uuid;
  v_receipt_id uuid;
  v_release_id uuid;
  v_in_production bigint;
begin
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'dispatch'),
    format('select public.receive_item(%L::uuid, %L, 101, null)', v_delivery_id, v_item_key),
    'exceeds released quantity'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.receive_item(v_delivery_id, v_item_key, 40, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select p.in_production into v_in_production
  from public.delivery_item_progress p
  where p.delivery_id = v_delivery_id and p.item_key = v_item_key;
  if v_in_production <> 60 then
    raise exception 'Receiving 40 did not leave 60 in production.';
  end if;
  if (select p.production_state from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Partly received' then
    raise exception 'A request with 40 of 100 received was not Partly received.';
  end if;
  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Dispatch' then
    raise exception 'A received but undelivered request was not in Dispatch.';
  end if;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'dispatch'),
    format('select public.pack_to_trip(%L::uuid, %L, 41, null, %L, null, null)',
      v_delivery_id, v_item_key, 'Test van'),
    'exceeds quantity received'
  );

  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  v_trip_one := public.pack_to_trip(v_delivery_id, v_item_key, 25, null, 'Test van A', null, 'Trip one');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  v_trip_two := public.pack_to_trip(v_delivery_id, v_item_key, 15, null, 'Test van B', null, 'Trip two');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  update partial_test_deliveries
  set trip_one = v_trip_one, trip_two = v_trip_two
  where name = 'main';
  if (select count(distinct t.vehicle) from public.dispatch_trips t
      where t.id in (v_trip_one, v_trip_two)) <> 2 then
    raise exception 'Trips on different vehicles were not kept separate.';
  end if;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'dispatch'),
    format(
      'select public.deliver_trip(%L::uuid, current_date, %L, %L::jsonb, null)',
      v_trip_one,
      'Test address',
      pg_catalog.jsonb_build_object(v_item_key, 26)::text
    ),
    'exceeds quantity packed'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.deliver_trip(v_trip_one, current_date, 'Main address', null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.deliver_trip(
    v_trip_two, current_date, 'Main address',
    pg_catalog.jsonb_build_object(v_item_key, 10), null
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if (select p.delivered from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 35
    or (select p.packed from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 35
    or (select p.available_to_pack from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 5 then
    raise exception 'Partial delivery did not return the undelivered 5 units to available_to_pack.';
  end if;
  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_delivery_id) <> 'Dispatch' then
    raise exception 'The partially delivered request was not in the Dispatch board stage.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  v_failed_trip := public.pack_to_trip(v_delivery_id, v_item_key, 5, null, 'Test van C', null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  update partial_test_deliveries set failed_trip = v_failed_trip where name = 'main';
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.fail_trip(v_failed_trip, 'Vehicle issue');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(
    v_delivery_id,
    (select user_id from partial_test_users where kind = 'admin')
  );
  if (select p.available_to_pack from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 5 then
    raise exception 'Failing a trip did not return its packed quantity to available_to_pack.';
  end if;
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.receive_item(v_delivery_id, v_item_key, 30, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select p.in_production into v_in_production
  from public.delivery_item_progress p
  where p.delivery_id = v_delivery_id and p.item_key = v_item_key;
  if v_in_production <> 30 then
    raise exception 'in_production was not 100 released minus 70 received.';
  end if;

  select r.id into v_release_id
  from public.store_release_logs r
  where r.delivery_id = v_delivery_id and r.item_key = v_item_key
    and r.qty = 40 and r.voided_at is null
  order by r.created_at desc limit 1;
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format('select public.void_entry(%L, %L::uuid, %L)',
      'store_release_logs', v_release_id, 'Would go below received'),
    'received quantity above released quantity'
  );
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'dispatch'),
    format('select public.void_entry(%L, %L::uuid, %L)',
      'store_release_logs', v_release_id, 'Dispatch cannot void release'),
    'Production store or administrator access is required to void a release.'
  );
  select r.id into v_receipt_id
  from public.dispatch_receipt_logs r
  where r.delivery_id = v_delivery_id and r.item_key = v_item_key
    and r.qty = 40 and r.voided_at is null
  order by r.created_at desc limit 1;
  if v_receipt_id is null then raise exception 'Receipt log was not recorded.'; end if;
end
$block$;

do $block$
declare
  store_id uuid := (select user_id from partial_test_users where kind = 'store');
  dispatch_id uuid := (select user_id from partial_test_users where kind = 'dispatch');
  admin_id uuid := (select user_id from partial_test_users where kind = 'admin');
  sales_id uuid := (select user_id from partial_test_users where kind = 'salesperson');
  v_delivery_id uuid;
  v_item_key text;
  v_past_delivery_id uuid;
  v_past_item_key text;
  v_past_only_trip uuid;
  v_past_trip uuid;
  v_today_trip uuid;
  v_expected_delivered_at timestamptz;
  v_actual_delivered_at timestamptz;
  fixture_tag text := replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Past delivery date test',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-PAST-' || fixture_tag,
        'item_name', 'Past-date item',
        'address', 'Past-date address',
        'quantity', '1',
        'goods_status', 'not_ready'
      )))
  returning id into v_past_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select item_key into v_past_item_key from public.delivery_items_expanded
  where delivery_id = v_past_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  perform public.release_item(v_past_delivery_id, v_past_item_key, null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.receive_item(v_past_delivery_id, v_past_item_key, 1, null);
  v_past_only_trip := public.pack_to_trip(
    v_past_delivery_id, v_past_item_key, 1, null, 'Past-only van', null, null
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.deliver_trip(
    v_past_only_trip, current_date - 1, 'Past-date address', null, null
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_past_delivery_id, admin_id);
  v_expected_delivered_at :=
    (current_date::timestamp - interval '1 microsecond')
      at time zone 'Africa/Nairobi';
  select d.delivered_at into v_actual_delivered_at
  from public.deliveries d where d.id = v_past_delivery_id;
  if v_actual_delivered_at is distinct from v_expected_delivered_at then
    raise exception 'Past delivery date did not sync delivered_at to the end of that local date.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Delivery date boundary test',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-DATES-' || fixture_tag,
        'item_name', 'Two-date item',
        'address', 'Date test address',
        'quantity', '2',
        'goods_status', 'not_ready'
      )))
  returning id into v_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select item_key into v_item_key from public.delivery_items_expanded
  where delivery_id = v_delivery_id;

  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  perform public.release_item(v_delivery_id, v_item_key, null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.receive_item(v_delivery_id, v_item_key, 2, null);
  v_past_trip := public.pack_to_trip(
    v_delivery_id, v_item_key, 1, null, 'Past-date van', null, null
  );
  v_today_trip := public.pack_to_trip(
    v_delivery_id, v_item_key, 1, null, 'Today-date van', null, null
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);

  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.deliver_trip(v_past_trip, current_date - 1, 'Date test address', null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_delivery_id, admin_id);

  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.deliver_trip(v_today_trip, current_date, 'Date test address', null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_delivery_id, admin_id);
  v_expected_delivered_at :=
    ((current_date + 1)::timestamp - interval '1 microsecond')
      at time zone 'Africa/Nairobi';
  select d.delivered_at into v_actual_delivered_at
  from public.deliveries d where d.id = v_delivery_id;
  if v_actual_delivered_at is distinct from v_expected_delivered_at then
    raise exception 'Multiple delivery dates did not sync delivered_at to the end of the latest local date.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Partial close test',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-CLOSE-' || fixture_tag,
        'item_name', 'Unreceived close item',
        'address', 'Close test address',
        'quantity', '2',
        'goods_status', 'not_ready'
      )))
  returning id into v_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select item_key into v_item_key from public.delivery_items_expanded
  where delivery_id = v_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  perform public.release_item(v_delivery_id, v_item_key, null, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', dispatch_id::text, true);
  perform public.receive_item(v_delivery_id, v_item_key, 1, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.close_with_balance(v_delivery_id, 'Close with unreceived balance');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_delivery_id, admin_id);
  if (select d.production_status from public.deliveries d where d.id = v_delivery_id) <> 'Not ready'
    or (select d.dispatch_status from public.deliveries d where d.id = v_delivery_id) <> 'Not delivered'
    or (select p.board_stage from public.delivery_request_progress p
        where p.delivery_id = v_delivery_id) <> 'Delivered' then
    raise exception 'Closing with an unreceived balance violated legacy status constraints or board-stage precedence.';
  end if;
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'main');
  v_item_key text := (select item_key from partial_test_deliveries where name = 'main');
  v_qty_changes integer;
begin
  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'store'),
    format('select public.change_job_card_total(%L::uuid, %L, 99)', v_delivery_id, v_item_key),
    'cannot be lower than the quantity already released'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.change_job_card_total(v_delivery_id, v_item_key, 120);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select count(*) into v_qty_changes from public.item_qty_changes q
  where q.delivery_id = v_delivery_id and q.item_key = v_item_key
    and q.old_qty = 100 and q.new_qty = 120;
  if v_qty_changes <> 1 then
    raise exception 'Changing the job card total above released quantity was not logged.';
  end if;

  perform pg_temp.partial_test_assert_failure(
    (select user_id from partial_test_users where kind = 'salesperson'),
    format(
      'update public.deliveries set items = pg_catalog.jsonb_set(items, %L, %L::jsonb, true) where id = %L::uuid',
      '{0,quantity}', '"101"', v_delivery_id
    ),
    'Only production store access or an administrator may change this job card total'
  );
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'main');
  v_item_key text := (select item_key from partial_test_deliveries where name = 'main');
  v_trip_id uuid := (select trip_two from partial_test_deliveries where name = 'main');
  v_release_id uuid;
  actor record;
  operation text;
begin
  select r.id into v_release_id
  from public.store_release_logs r
  where r.delivery_id = v_delivery_id and r.item_key = v_item_key
    and r.qty = 60 and r.voided_at is null
  order by r.created_at desc limit 1;
  for actor in
    select u.user_id from partial_test_users u
    where u.kind in ('salesperson', 'production_read_only')
  loop
    foreach operation in array array[
      'release_item', 'receive_item', 'pack_to_trip', 'deliver_trip',
      'fail_trip', 'void_entry', 'close_with_balance', 'change_job_card_total'
    ] loop
      perform pg_temp.partial_test_assert_rpc_denied(
        operation, actor.user_id, v_delivery_id, v_item_key, v_trip_id, v_release_id
      );
    end loop;
  end loop;
end
$block$;

do $block$
declare
  v_delivery_id uuid := (select delivery_id from partial_test_deliveries where name = 'removal');
  v_item_key text := (select item_key from partial_test_deliveries where name = 'removal');
  v_release_id uuid;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.release_item(v_delivery_id, v_item_key, 3, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select r.id into v_release_id from public.store_release_logs r
  where r.delivery_id = v_delivery_id and r.item_key = v_item_key and r.voided_at is null
  order by r.created_at desc limit 1;
  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'store'), true);
  perform public.void_entry('store_release_logs', v_release_id, 'Incorrect release');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if (select p.released from public.delivery_item_progress p
      where p.delivery_id = v_delivery_id and p.item_key = v_item_key) <> 0 then
    raise exception 'Voiding a release with a reason did not update totals.';
  end if;
  if not exists (
    select 1 from public.store_release_logs r
    where r.id = v_release_id and r.voided_at is not null
      and r.voided_by = (select user_id from partial_test_users where kind = 'store')
      and r.void_reason = 'Incorrect release'
  ) then
    raise exception 'Voiding a release did not retain its reason and actor.';
  end if;
end
$block$;

do $block$
declare
  store_id uuid := (select user_id from partial_test_users where kind = 'store');
  sales_id uuid := (select user_id from partial_test_users where kind = 'salesperson');
  admin_id uuid := (select user_id from partial_test_users where kind = 'admin');
  v_delivery_id uuid;
  v_item_key text;
  v_trip_id uuid;
  fixture_tag text := replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', store_id::text, true);
  insert into public.deliveries
    (created_by, salesperson_id, handoff_status, client_name, items)
  values
    (store_id, sales_id, 'pending_details', 'Admin override test',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'so_number', 'SO-PARTIAL-OVERRIDE-' || fixture_tag,
        'item_name', 'Override item',
        'address', 'Override address',
        'quantity', '10',
        'goods_status', 'not_ready'
      )))
  returning id into v_delivery_id;
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  select item_key into v_item_key from public.delivery_items_expanded
  where delivery_id = v_delivery_id;

  perform pg_temp.partial_test_assert_failure(
    admin_id,
    format('select public.release_item(%L::uuid, %L, 11, null)', v_delivery_id, v_item_key),
    'administrator override requires a note'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.release_item(v_delivery_id, v_item_key, 11, 'Approved release override');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_failure(
    admin_id,
    format('select public.receive_item(%L::uuid, %L, 12, null)', v_delivery_id, v_item_key),
    'administrator override requires a note'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.receive_item(v_delivery_id, v_item_key, 12, 'Approved receipt override');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_failure(
    admin_id,
    format('select public.pack_to_trip(%L::uuid, %L, 13, null, %L, null, null)',
      v_delivery_id, v_item_key, 'Override van'),
    'administrator override requires a note'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  v_trip_id := public.pack_to_trip(
    v_delivery_id, v_item_key, 13, null, 'Override van', null, 'Approved pack override'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_failure(
    admin_id,
    format(
      'select public.deliver_trip(%L::uuid, current_date, %L, %L::jsonb, null)',
      v_trip_id, 'Override address', pg_catalog.jsonb_build_object(v_item_key, 14)::text
    ),
    'administrator override requires a note'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.deliver_trip(
    v_trip_id, current_date, 'Override address',
    pg_catalog.jsonb_build_object(v_item_key, 14), 'Approved delivery override'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if not exists (
    select 1 from public.store_release_logs r
    where r.delivery_id = v_delivery_id and r.note like '%Approved release override%'
  ) or not exists (
    select 1 from public.dispatch_receipt_logs r
    where r.delivery_id = v_delivery_id and r.note like '%Approved receipt override%'
  ) or not exists (
    select 1 from public.dispatch_trips t
    where t.id = v_trip_id
      and t.note like '%Approved pack override%'
      and t.note like '%Approved delivery override%'
  ) then
    raise exception 'Administrator override notes were not retained.';
  end if;
end
$block$;

do $block$
declare
  admin_id uuid := (select user_id from partial_test_users where kind = 'admin');
  v_main_id uuid := (select delivery_id from partial_test_deliveries where name = 'main');
  v_main_key text := (select item_key from partial_test_deliveries where name = 'main');
  v_ready_id uuid := (select delivery_id from partial_test_deliveries where name = 'legacy_ready');
  v_delivered_id uuid := (select delivery_id from partial_test_deliveries where name = 'legacy_delivered');
  v_pending_id uuid := (select delivery_id from partial_test_deliveries where name = 'legacy_pending');
  first_snapshot jsonb;
  second_snapshot jsonb;
  v_stage text;
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform pg_catalog.set_config('workspace.partial_cutover', 'on', true);
  update public.deliveries
  set production_status = 'Ready', dispatch_status = 'Not delivered', ready_at = now()
  where id = v_ready_id;
  update public.deliveries
  set production_status = 'Ready', dispatch_status = 'Delivered',
      handoff_status = 'requested',
      ready_at = now(), dispatched_at = now(),
      delivered_at = ((current_date - 1)::timestamp at time zone 'Africa/Nairobi'),
      client_name = 'Delivered backfill test',
      contact_name = 'Test contact',
      contact_number = '5550100',
      delivery_date = current_date,
      transport = 'Client'
  where id = v_delivered_id;
  perform pg_catalog.set_config('workspace.partial_cutover', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);

  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_ready_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_delivered_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_pending_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_ready_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_delivered_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_delivered_id, admin_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_pending_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);

  if (select d.goods_status from public.deliveries d where d.id = v_ready_id)
       is distinct from 'ready'::text
    or (select d.production_status from public.deliveries d where d.id = v_ready_id)
       is distinct from 'Ready'::text
    or (select d.dispatch_status from public.deliveries d where d.id = v_ready_id)
       is distinct from 'Not delivered'::text then
    raise exception 'Cutover changed the legacy Ready request status columns.';
  end if;
  if (select d.goods_status from public.deliveries d where d.id = v_delivered_id)
       is distinct from 'ready'::text
    or (select d.production_status from public.deliveries d where d.id = v_delivered_id)
       is distinct from 'Ready'::text
    or (select d.dispatch_status from public.deliveries d where d.id = v_delivered_id)
       is distinct from 'Delivered'::text then
    raise exception 'Cutover changed the legacy Delivered request status columns.';
  end if;
  if (select d.goods_status from public.deliveries d where d.id = v_pending_id)
       is distinct from 'not_ready'::text
    or (select d.production_status from public.deliveries d where d.id = v_pending_id)
       is distinct from 'Not ready'::text
    or (select d.dispatch_status from public.deliveries d where d.id = v_pending_id)
       is distinct from 'Not delivered'::text then
    raise exception 'Cutover statuses for a not-started request are not the expected legacy values.';
  end if;
  if (select p.released from public.delivery_request_progress p
      where p.delivery_id = v_ready_id) <> 20
    or (select p.received from public.delivery_request_progress p
      where p.delivery_id = v_ready_id) <> 20 then
    raise exception 'Ready request backfill did not populate its passed stages.';
  end if;
  if (select p.delivered from public.delivery_request_progress p
      where p.delivery_id = v_delivered_id) <> 30 then
    raise exception 'Delivered request backfill did not create its delivered trip.';
  end if;
  if (select p.released from public.delivery_request_progress p
      where p.delivery_id = v_pending_id) <> 0 then
    raise exception 'Not-started request unexpectedly received backfill ledger rows.';
  end if;

  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_ready_id) <> 'Dispatch'
    or (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_delivered_id) <> 'Delivered'
    or (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_pending_id) <> 'Production store' then
    raise exception 'Backfilled requests do not occupy the expected single board stage.';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
    d.id,
    d.goods_status,
    d.production_status,
    d.dispatch_status,
    d.ready_at,
    d.dispatched_at,
    d.delivered_at,
    d.transport,
    (select count(*) from public.store_release_logs r where r.delivery_id = d.id),
    (select count(*) from public.dispatch_receipt_logs r where r.delivery_id = d.id),
    (select count(*) from public.dispatch_trips t where t.delivery_id = d.id),
    (select count(*) from public.dispatch_trip_items ti where ti.delivery_id = d.id)
  ) order by d.id)
  into first_snapshot
  from public.deliveries d where d.id in (v_ready_id, v_delivered_id, v_pending_id);

  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_ready_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_delivered_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_run_legacy_backfill(v_pending_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_ready_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_delivered_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.partial_sync_delivery_status(v_pending_id);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
    d.id,
    d.goods_status,
    d.production_status,
    d.dispatch_status,
    d.ready_at,
    d.dispatched_at,
    d.delivered_at,
    d.transport,
    (select count(*) from public.store_release_logs r where r.delivery_id = d.id),
    (select count(*) from public.dispatch_receipt_logs r where r.delivery_id = d.id),
    (select count(*) from public.dispatch_trips t where t.delivery_id = d.id),
    (select count(*) from public.dispatch_trip_items ti where ti.delivery_id = d.id)
  ) order by d.id)
  into second_snapshot
  from public.deliveries d where d.id in (v_ready_id, v_delivered_id, v_pending_id);
  if first_snapshot is distinct from second_snapshot then
    raise exception 'Running cutover backfill and status sync twice changed fixture results.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub',
    (select user_id::text from partial_test_users where kind = 'dispatch'), true);
  perform public.receive_item(v_main_id, v_main_key, 30, null);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if (select p.board_stage from public.delivery_request_progress p
      where p.delivery_id = v_main_id) not in ('Production store', 'Production', 'Dispatch', 'Delivered') then
    raise exception 'A request did not occupy exactly one valid board stage.';
  end if;
  if exists (
    select 1 from public.delivery_request_progress p
    where p.delivery_id in (v_main_id, v_ready_id, v_delivered_id, v_pending_id)
      and p.board_stage is distinct from case
        when p.balance = 0 or p.closed_short then 'Delivered'
        when p.received > p.delivered then 'Dispatch'
        when p.released > p.received then 'Production'
        else 'Production store' end
  ) then
    raise exception 'A request board stage disagrees with the required precedence rule.';
  end if;

  perform pg_catalog.set_config('request.jwt.claim.sub', admin_id::text, true);
  perform public.close_with_balance(v_main_id, 'Customer accepted remaining balance');
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.partial_test_assert_delivery_constraints(v_main_id, admin_id);
  select p.board_stage into v_stage
  from public.delivery_request_progress p where p.delivery_id = v_main_id;
  if v_stage <> 'Delivered' then
    raise exception 'close_with_balance did not move the request to Delivered.';
  end if;
end
$block$;

rollback;
