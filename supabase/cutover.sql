-- Existing JavaScript dependencies to switch to delivery_request_progress or
-- delivery_item_progress before removing the legacy status columns:
-- js/features/deliveries.js:71,407 (activity/list selects); :469,1202,2332
-- (pending handoff filters); :1493-1548 (fetch/realtime selects);
-- :1535-1536 (status refresh signature); :1659-1680 (production/dispatch
-- actions); :1729-1733 (role status chips); :1821-1824 (production/dispatch
-- filters); :1854 (goods status pill); :2088-2144 (status writes);
-- :2231,2287-2292 (detail rendering); :2700-2709 (activity report filters).
-- js/utils/delivery-rows.js:20-45 (urgent test and status markup).
-- js/pages/status-board.js:106-180,204,375-376,425,839-848,893 (stage,
-- display, date sort, dispatch filter, diagnostics and deliveries select).
-- js/portal.js:31,260 (home deliveries select and summary).
-- js/pages/vehicles.js:60 (dispatched_at vehicle activity filter).

begin;

create or replace function public.guard_delivery_update()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  actor_role text := public.current_role()::text;
  prod_change boolean := new.production_status is distinct from old.production_status
    or new.ready_at is distinct from old.ready_at;
  disp_change boolean := new.dispatch_status is distinct from old.dispatch_status
    or new.dispatched_at is distinct from old.dispatched_at
    or new.delivered_at is distinct from old.delivered_at
    or new.delivery_date is distinct from old.delivery_date
    or new.transport is distinct from old.transport
    or new.vehicle_id is distinct from old.vehicle_id;
begin
  if current_setting('workspace.partial_status_sync', true) = 'on'
    and pg_catalog.pg_trigger_depth() > 0 then
    return new;
  end if;
  if actor_role = 'admin' then
    return new;
  elsif actor_role = 'salesperson'
    and not (public.has_production_access() and prod_change)
    and not (public.has_dispatch_access() and disp_change) then
    if old.salesperson_id is distinct from (select auth.uid())
      or old.handoff_status is null
      or old.handoff_status not in ('pending_details', 'requested')
      or old.dispatch_status = 'Delivered'
      or old.delivered_at is not null
      or new.handoff_status is distinct from 'requested'
      or new.salesperson_id is distinct from old.salesperson_id
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by,
          new.production_status, new.dispatch_status, new.ready_at, new.dispatched_at,
          new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by,
          old.production_status, old.dispatch_status, old.ready_at, old.dispatched_at,
          old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Salespeople may edit assigned requests until delivery';
    end if;
    return new;
  elsif public.has_production_access()
    and (prod_change or (actor_role = 'production' and not disp_change)) then
    if old.salesperson_id = (select auth.uid()) then
      raise exception 'Production cannot mark its assigned salesperson request Ready';
    end if;
    if old.handoff_status is null
      or old.handoff_status not in ('pending_details', 'requested')
      or new.handoff_status is distinct from old.handoff_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.client_name, new.contact_name, new.contact_number, new.items,
          new.delivery_time, new.delivery_time_any, new.delivery_date, new.special_instruction,
          new.dispatch_status, new.dispatched_at, new.delivered_at, new.transport, new.vehicle_id)
       is distinct from
       (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.client_name, old.contact_name, old.contact_number, old.items,
          old.delivery_time, old.delivery_time_any, old.delivery_date, old.special_instruction,
          old.dispatch_status, old.dispatched_at, old.delivered_at, old.transport, old.vehicle_id)
      or old.production_status is distinct from 'Not ready'
      or new.production_status is distinct from 'Ready'
      or old.goods_status is null
      or old.goods_status not in ('ready', 'partial') then
      raise exception 'Production may only mark a goods-ready request Ready once';
    end if;
    new.ready_at := now();
    return new;
  elsif public.has_dispatch_access()
    and (disp_change or (actor_role = 'dispatch' and not prod_change)) then
    if old.handoff_status not in ('pending_details', 'requested')
      or new.handoff_status is distinct from old.handoff_status
      or old.production_status <> 'Ready'
      or new.production_status is distinct from old.production_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.handoff_status, new.goods_status, new.goods_status_updated_at, new.client_name,
          new.contact_name, new.contact_number, new.items, new.delivery_time,
          new.delivery_time_any, new.special_instruction, new.ready_at)
         is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.handoff_status, old.goods_status, old.goods_status_updated_at, old.client_name,
          old.contact_name, old.contact_number, old.items, old.delivery_time,
          old.delivery_time_any, old.special_instruction, old.ready_at) then
      raise exception 'Dispatch may update only a production-ready request';
    end if;
    if old.dispatch_status = 'Delivered' then
      raise exception 'Delivered requests cannot be changed';
    end if;
    if old.dispatched_at is null then
      if old.salesperson_id = (select auth.uid()) then
        raise exception 'Dispatch cannot pack its assigned salesperson request';
      end if;
      if new.delivery_date is distinct from old.delivery_date
        or new.dispatch_status is distinct from old.dispatch_status
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id then
        raise exception 'Pack this request before editing its delivery date or transport';
      end if;
      new.dispatched_at := now();
      new.delivered_at := null;
      return new;
    end if;
    new.dispatched_at := old.dispatched_at;
    if new.delivery_date is distinct from old.delivery_date then
      if new.dispatch_status is distinct from old.dispatch_status
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id then
        raise exception 'Dispatch may only update the delivery date by itself';
      end if;
      return new;
    end if;
    if new.dispatch_status = 'Delivered' then
      if new.transport is null or new.transport not in ('Client', 'Company') then
        raise exception 'Choose Client or Company transport';
      end if;
      if new.transport = 'Company' and not exists (
        select 1 from public.vehicles v where v.id = new.vehicle_id and v.active
      ) then
        raise exception 'Choose an active company vehicle';
      end if;
      if new.transport = 'Client' then new.vehicle_id := null; end if;
      new.delivered_at := now();
    else
      if new.transport is not null and new.transport not in ('Client', 'Company') then
        raise exception 'Choose a transport type';
      end if;
      if new.transport = 'Company' and new.vehicle_id is not null and not exists (
        select 1 from public.vehicles v where v.id = new.vehicle_id and v.active
      ) then
        raise exception 'Choose an active company vehicle';
      end if;
      if new.transport is null and new.vehicle_id is not null then
        raise exception 'Choose a transport type before choosing a vehicle';
      end if;
      if new.transport = 'Client' then new.vehicle_id := null; end if;
      new.delivered_at := null;
    end if;
    return new;
  elsif public.has_production_store_access()
    and (old.created_by = (select auth.uid()) or old.created_by = old.salesperson_id) then
    if new.created_by is distinct from old.created_by
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.handoff_status, new.production_status, new.dispatch_status, new.ready_at,
          new.dispatched_at, new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.handoff_status, old.production_status, old.dispatch_status, old.ready_at,
          old.dispatched_at, old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Production store users may edit only delivery details';
    end if;
    return new;
  end if;
  raise exception 'Not authorized to update delivery requests';
end
$function$;

create or replace function public.partial_sync_delivery_status(target_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  previous_sync_setting text := current_setting('workspace.partial_status_sync', true);
  current_items jsonb;
  next_items jsonb;
  total_released bigint;
  total_packed bigint;
  first_receipt_at timestamptz;
  first_pack_at timestamptz;
  latest_trip_delivery_at timestamptz;
  all_released_received boolean;
  all_items_delivered boolean;
  fully_received boolean;
  fully_delivered boolean;
  legacy_delivered boolean;
  next_production_status text;
  next_dispatch_status text;
  next_transport text;
  next_ready_at timestamptz;
  next_dispatched_at timestamptz;
  next_delivered_at timestamptz;
  current_transport text;
  current_vehicle_id uuid;
  current_handoff_status text;
  current_client_name text;
  current_contact_name text;
  current_contact_number text;
  current_delivery_date date;
  current_closed_short boolean;
  current_ready_at timestamptz;
  current_dispatched_at timestamptz;
  current_delivered_at timestamptz;
  current_production_status text;
  current_dispatch_status text;
begin
  if current_setting('workspace.partial_cutover', true) = 'on' then return; end if;
  select d.items, d.closed_short, d.ready_at, d.dispatched_at, d.delivered_at,
         d.production_status, d.dispatch_status, d.transport, d.vehicle_id,
         d.handoff_status, d.client_name, d.contact_name, d.contact_number, d.delivery_date
  into current_items, current_closed_short, current_ready_at, current_dispatched_at,
       current_delivered_at, current_production_status, current_dispatch_status,
       current_transport, current_vehicle_id, current_handoff_status, current_client_name,
       current_contact_name, current_contact_number, current_delivery_date
  from public.deliveries d
  where d.id = target_delivery_id
  for update;
  if not found then return; end if;

  select
    coalesce(sum(p.released), 0),
    coalesce(sum(p.packed), 0),
    coalesce(bool_and(p.available_to_receive = 0), false),
    coalesce(bool_and(p.balance = 0), true)
  into total_released, total_packed,
       all_released_received, all_items_delivered
  from public.delivery_item_progress p
  where p.delivery_id = target_delivery_id;
  fully_received := total_released > 0 and all_released_received;
  fully_delivered := current_closed_short or all_items_delivered;
  next_production_status := case when fully_received then 'Ready' else 'Not ready' end;
  if next_production_status = 'Not ready'
    and current_handoff_status is distinct from 'pending_details'
    and not (
      current_client_name is not null
      and pg_catalog.length(pg_catalog.btrim(current_client_name)) between 1 and 160
      and current_contact_name is not null
      and pg_catalog.length(pg_catalog.btrim(current_contact_name)) between 1 and 160
      and current_contact_number is not null
      and pg_catalog.length(pg_catalog.btrim(current_contact_number)) > 0
      and current_delivery_date is not null
    ) then
    raise exception 'Cannot set production status to Not ready until required delivery details are complete.';
  end if;
  legacy_delivered := fully_received and fully_delivered;
  next_dispatch_status := case when legacy_delivered then 'Delivered' else 'Not delivered' end;
  select min(r.created_at) into first_receipt_at
  from public.dispatch_receipt_logs r
  where r.delivery_id = target_delivery_id and r.voided_at is null;
  select min(t.created_at) into first_pack_at
  from public.dispatch_trips t
  where t.delivery_id = target_delivery_id
    and t.voided_at is null and t.status <> 'Failed';
  first_pack_at := coalesce(first_pack_at, current_dispatched_at);
  select max(
    (((t.delivered_on + 1)::timestamp - interval '1 microsecond')
      at time zone 'Africa/Nairobi')
  ) into latest_trip_delivery_at
  from public.dispatch_trips t
  where t.delivery_id = target_delivery_id
    and t.voided_at is null and t.status = 'Delivered'
    and t.delivered_on is not null;

  -- Keep legacy timestamps ordered: ready_at <= dispatched_at <= delivered_at.
  -- delivered_at uses the end of the latest delivered_on date in Nairobi time,
  -- preserving a later existing value; closed-short completion without a delivered
  -- trip uses now(). dispatched_at is the earlier of first pack and delivered_at,
  -- and ready_at is the earlier of first receipt and dispatched_at.
  next_delivered_at := case when legacy_delivered then greatest(
    coalesce(latest_trip_delivery_at, current_delivered_at, now()),
    coalesce(current_delivered_at, latest_trip_delivery_at, now())
  ) else null end;
  next_dispatched_at := case
    when legacy_delivered then least(coalesce(first_pack_at, now()), next_delivered_at)
    when total_packed > 0 then coalesce(first_pack_at, now())
    else null
  end;
  next_ready_at := case
    when fully_received and next_dispatched_at is not null
      then least(coalesce(first_receipt_at, current_ready_at, now()), next_dispatched_at)
    when fully_received then coalesce(first_receipt_at, current_ready_at, now())
    else null
  end;
  next_transport := case
    when legacy_delivered then case
      when current_transport = 'Company' and current_vehicle_id is not null then 'Company'
      when current_transport = 'Client' then 'Client'
      when current_vehicle_id is not null then 'Company'
      else 'Client'
    end
    else current_transport
  end;

  select coalesce(
    pg_catalog.jsonb_agg(
      case
        -- Legacy partial status has no quantity to reconstruct until a release is logged.
        when line.item ->> 'goods_status' = 'partial'
          and not exists (
            select 1 from public.store_release_logs r
            where r.delivery_id = target_delivery_id
              and r.item_key = coalesce(lower(nullif(line.item ->> 'item_key', '')),
                public.partial_legacy_item_key(target_delivery_id, line.ordinality))
          ) then line.item
        else pg_catalog.jsonb_set(
          line.item,
          '{goods_status}',
          pg_catalog.to_jsonb(case
            when progress.available_to_release = 0
              and progress.job_card_total > 0 then 'ready'
            when coalesce(progress.released, 0) > 0 then 'partial'
            else 'not_ready'
          end),
          true
        )
      end
      order by line.ordinality
    ),
    current_items
  )
  into next_items
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(current_items) = 'array'
      then current_items else '[]'::jsonb end
  ) with ordinality as line(item, ordinality)
  left join public.delivery_item_progress progress
    on progress.delivery_id = target_delivery_id
    and progress.item_key = coalesce(lower(nullif(line.item ->> 'item_key', '')),
      public.partial_legacy_item_key(target_delivery_id, line.ordinality));

  if next_items is distinct from current_items
    or next_production_status is distinct from current_production_status
    or next_dispatch_status is distinct from current_dispatch_status
    or next_transport is distinct from current_transport
    or next_ready_at is distinct from current_ready_at
    or next_dispatched_at is distinct from current_dispatched_at
    or next_delivered_at is distinct from current_delivered_at then
    perform pg_catalog.set_config('workspace.partial_status_sync', 'on', true);
    update public.deliveries d
    set items = next_items,
        production_status = next_production_status,
        dispatch_status = next_dispatch_status,
        transport = next_transport,
        ready_at = next_ready_at,
        dispatched_at = next_dispatched_at,
        delivered_at = next_delivered_at
    where d.id = target_delivery_id;
    perform pg_catalog.set_config(
      'workspace.partial_status_sync',
      coalesce(previous_sync_setting, ''),
      true
    );
  end if;
end
$function$;

create or replace function public.partial_sync_delivery_status_trigger()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare target_delivery_id uuid;
begin
  if current_setting('workspace.partial_cutover', true) = 'on'
    or current_setting('workspace.partial_status_sync', true) = 'on' then
    return new;
  end if;
  if tg_table_name = 'deliveries' then
    target_delivery_id := new.id;
  else
    target_delivery_id := new.delivery_id;
  end if;
  perform public.partial_sync_delivery_status(target_delivery_id);
  return new;
end
$function$;

create or replace function public.partial_run_legacy_backfill(target_delivery_id uuid default null)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  previous_cutover_setting text := current_setting('workspace.partial_cutover', true);
begin
  perform pg_catalog.set_config('workspace.partial_cutover', 'on', true);

  insert into public.store_release_logs
    (id, delivery_id, item_key, qty, done_on, user_id, note)
  select
    md5('partial-cutover-release:' || item.delivery_id::text || ':' || item.item_key)::uuid,
    item.delivery_id,
    item.item_key,
    (item.job_card_total - coalesce(active.qty, 0))::integer,
    coalesce(d.ready_at::date, d.created_at::date, current_date),
    coalesce(d.salesperson_id, d.created_by),
    '[CUTOVER] Legacy release'
  from public.delivery_items_expanded item
  join public.deliveries d on d.id = item.delivery_id
  left join lateral (
    select sum(r.qty) as qty from public.store_release_logs r
    where r.delivery_id = item.delivery_id and r.item_key = item.item_key
      and r.voided_at is null
  ) active on true
  where (target_delivery_id is null or d.id = target_delivery_id)
    and item.job_card_total > coalesce(active.qty, 0)
    and (
      d.production_status = 'Ready'
      or d.dispatched_at is not null
      or d.dispatch_status = 'Delivered'
      or d.delivered_at is not null
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(d.items) with ordinality as old_line(item, ordinality)
        where old_line.ordinality = item.ordinality
          and old_line.item ->> 'goods_status' = 'ready'
      )
    )
  on conflict (id) do nothing;

  insert into public.dispatch_receipt_logs
    (id, delivery_id, item_key, qty, done_on, user_id, note)
  select
    md5('partial-cutover-receipt:' || item.delivery_id::text || ':' || item.item_key)::uuid,
    item.delivery_id,
    item.item_key,
    (item.job_card_total - coalesce(active.qty, 0))::integer,
    coalesce(d.ready_at::date, d.created_at::date, current_date),
    coalesce(d.salesperson_id, d.created_by),
    '[CUTOVER] Legacy receipt'
  from public.delivery_items_expanded item
  join public.deliveries d on d.id = item.delivery_id
  left join lateral (
    select sum(r.qty) as qty from public.dispatch_receipt_logs r
    where r.delivery_id = item.delivery_id and r.item_key = item.item_key
      and r.voided_at is null
  ) active on true
  where (target_delivery_id is null or d.id = target_delivery_id)
    and item.job_card_total > coalesce(active.qty, 0)
    and (
      d.production_status = 'Ready'
      or d.dispatched_at is not null
      or d.dispatch_status = 'Delivered'
      or d.delivered_at is not null
    )
  on conflict (id) do nothing;

  insert into public.dispatch_trips
    (id, delivery_id, vehicle, status, delivered_on, delivery_address, note)
  select
    public.partial_legacy_item_key(d.id, 0)::uuid,
    d.id,
    coalesce(nullif(v.registration_number, ''), nullif(d.transport, ''), 'Legacy'),
    case when d.dispatch_status = 'Delivered' or d.delivered_at is not null
      then 'Delivered' else 'Packed' end,
    case when d.dispatch_status = 'Delivered' or d.delivered_at is not null
      then coalesce(d.delivered_at::date, d.delivery_date, d.created_at::date) else null end,
    coalesce(addresses.address, ''),
    '[CUTOVER] Legacy trip'
  from public.deliveries d
  left join public.vehicles v on v.id = d.vehicle_id
  left join lateral (
    select string_agg(distinct nullif(btrim(line.item ->> 'address'), ''), ' · ') as address
    from pg_catalog.jsonb_array_elements(d.items) as line(item)
  ) addresses on true
  where (target_delivery_id is null or d.id = target_delivery_id)
    and (d.dispatched_at is not null or d.dispatch_status = 'Delivered' or d.delivered_at is not null)
    and exists (
      select 1 from public.delivery_item_progress p
      where p.delivery_id = d.id
        and (p.job_card_total > p.packed or (
          (d.dispatch_status = 'Delivered' or d.delivered_at is not null)
          and p.job_card_total > p.delivered
        ))
    )
  on conflict (id) do nothing;

  insert into public.dispatch_trip_items
    (id, trip_id, delivery_id, item_key, qty_packed, qty_delivered)
  select
    md5('partial-cutover-trip-item:' || item.delivery_id::text || ':' || item.item_key)::uuid,
    public.partial_legacy_item_key(item.delivery_id, 0)::uuid,
    item.delivery_id,
    item.item_key,
    greatest(
      item.job_card_total - coalesce(item.packed, 0),
      case when d.dispatch_status = 'Delivered' or d.delivered_at is not null
        then item.job_card_total - coalesce(item.delivered, 0) else 0 end
    )::integer,
    case when d.dispatch_status = 'Delivered' or d.delivered_at is not null
      then greatest(item.job_card_total - coalesce(item.delivered, 0), 0)::integer
      else 0 end
  from (
    select p.delivery_id, p.item_key, p.job_card_total, p.packed, p.delivered
    from public.delivery_item_progress p
  ) item
  join public.deliveries d on d.id = item.delivery_id
  join public.dispatch_trips t
    on t.id = public.partial_legacy_item_key(item.delivery_id, 0)::uuid
  where (target_delivery_id is null or d.id = target_delivery_id)
    and (d.dispatched_at is not null or d.dispatch_status = 'Delivered' or d.delivered_at is not null)
    and greatest(
      item.job_card_total - coalesce(item.packed, 0),
      case when d.dispatch_status = 'Delivered' or d.delivered_at is not null
        then item.job_card_total - coalesce(item.delivered, 0) else 0 end
    ) > 0
  on conflict (trip_id, item_key) do nothing;

  perform pg_catalog.set_config(
    'workspace.partial_cutover',
    coalesce(previous_cutover_setting, ''),
    true
  );
end
$function$;

drop trigger if exists partial_sync_release_log on public.store_release_logs;
create trigger partial_sync_release_log
after insert or update on public.store_release_logs
for each row execute function public.partial_sync_delivery_status_trigger();
drop trigger if exists partial_sync_receipt_log on public.dispatch_receipt_logs;
create trigger partial_sync_receipt_log
after insert or update on public.dispatch_receipt_logs
for each row execute function public.partial_sync_delivery_status_trigger();
drop trigger if exists partial_sync_trip on public.dispatch_trips;
create trigger partial_sync_trip
after insert or update on public.dispatch_trips
for each row execute function public.partial_sync_delivery_status_trigger();
drop trigger if exists partial_sync_trip_item on public.dispatch_trip_items;
create trigger partial_sync_trip_item
after insert or update on public.dispatch_trip_items
for each row execute function public.partial_sync_delivery_status_trigger();
drop trigger if exists partial_sync_delivery on public.deliveries;
create trigger partial_sync_delivery
after insert or update on public.deliveries
for each row execute function public.partial_sync_delivery_status_trigger();

revoke all on function public.partial_sync_delivery_status(uuid) from public, anon, authenticated;
revoke all on function public.partial_sync_delivery_status_trigger() from public, anon, authenticated;
revoke all on function public.partial_run_legacy_backfill(uuid) from public, anon, authenticated;

select pg_catalog.set_config('workspace.partial_cutover', 'on', true);
select public.partial_run_legacy_backfill(null);
select pg_catalog.set_config('workspace.partial_cutover', '', true);

do $block$
declare delivery_row record;
begin
  for delivery_row in select d.id from public.deliveries d loop
    perform public.partial_sync_delivery_status(delivery_row.id);
  end loop;
end
$block$;

commit;
