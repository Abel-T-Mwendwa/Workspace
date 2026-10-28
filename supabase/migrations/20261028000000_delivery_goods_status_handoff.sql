alter table public.deliveries
  add column if not exists goods_status text
    check (goods_status in ('ready', 'partial', 'not_ready'));

create or replace function public.delivery_goods_status(value jsonb)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  line_count integer;
  all_ready boolean;
  has_ready boolean;
  has_partial boolean;
  has_not_ready boolean;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array' then
    return null;
  end if;

  select count(*),
    coalesce(bool_and(item ->> 'goods_status' = 'ready'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'ready'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'partial'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'not_ready'), false)
  into line_count, all_ready, has_ready, has_partial, has_not_ready
  from pg_catalog.jsonb_array_elements(value) as lines(item);

  if line_count = 0 or not (has_ready or has_partial or has_not_ready) then
    return null;
  elsif all_ready then
    return 'ready';
  elsif has_partial or has_ready and has_not_ready then
    return 'partial';
  end if;
  return 'not_ready';
end
$$;

alter table public.deliveries disable trigger user;

update public.deliveries
set goods_status = public.delivery_goods_status(items);

alter table public.deliveries enable trigger user;

create or replace function public.sync_delivery_goods_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.goods_status := public.delivery_goods_status(new.items);
  return new;
end
$$;

drop trigger if exists deliveries_goods_status_before_insert on public.deliveries;
create trigger deliveries_goods_status_before_insert
before insert on public.deliveries
for each row execute function public.sync_delivery_goods_status();

drop trigger if exists deliveries_goods_status_before_update on public.deliveries;
create trigger deliveries_goods_status_before_update
before update on public.deliveries
for each row execute function public.sync_delivery_goods_status();

create or replace function public.guard_delivery_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := public.current_role()::text;
begin
  if actor_role = 'admin' then
    return new;
  elsif public.has_production_store_access()
    and old.handoff_status = 'pending_details'
    and old.created_by = (select auth.uid()) then
    if old.created_by is distinct from (select auth.uid())
      or old.handoff_status <> 'pending_details'
      or new.handoff_status <> 'pending_details'
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.handoff_status, new.production_status, new.dispatch_status, new.ready_at,
          new.dispatched_at, new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.handoff_status, old.production_status, old.dispatch_status, old.ready_at,
          old.dispatched_at, old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Production store users may edit only their own awaiting requests';
    end if;
    return new;
  elsif actor_role = 'salesperson' then
    if old.salesperson_id is distinct from (select auth.uid())
      or old.handoff_status <> 'pending_details'
      or new.handoff_status <> 'requested'
      or new.salesperson_id is distinct from old.salesperson_id
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by,
          new.production_status, new.dispatch_status, new.ready_at, new.dispatched_at,
          new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by,
          old.production_status, old.dispatch_status, old.ready_at, old.dispatched_at,
          old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Salespeople may complete only their assigned awaiting requests';
    end if;
    return new;
  elsif actor_role = 'production' then
    if old.handoff_status <> 'requested'
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
      or old.production_status <> 'Not ready' or new.production_status <> 'Ready' then
      raise exception 'Production may only mark a request Ready once';
    end if;
    new.ready_at := now();
    return new;
  elsif actor_role = 'dispatch' then
    if old.handoff_status <> 'requested'
      or new.handoff_status is distinct from old.handoff_status
      or old.production_status <> 'Ready'
      or new.production_status is distinct from old.production_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.client_name, new.contact_name, new.contact_number, new.items,
          new.delivery_time, new.delivery_time_any, new.delivery_date, new.special_instruction, new.ready_at)
         is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.client_name, old.contact_name, old.contact_number, old.items,
          old.delivery_time, old.delivery_time_any, old.delivery_date, old.special_instruction, old.ready_at) then
      raise exception 'Dispatch is available only after production marks the request Ready';
    end if;
    if old.dispatch_status = 'Delivered' then
      raise exception 'Delivered requests cannot be changed';
    end if;
    if old.dispatched_at is null then
      if new.dispatch_status is distinct from old.dispatch_status
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id then
        raise exception 'Pack this request before choosing transport or marking it Delivered';
      end if;
      new.dispatched_at := now();
      new.delivered_at := null;
      return new;
    end if;
    new.dispatched_at := old.dispatched_at;
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
  end if;
  raise exception 'Not authorized to update delivery requests';
end
$$;

drop policy if exists "production store edit own pending deliveries" on public.deliveries;
create policy "production store edit own pending deliveries" on public.deliveries
for update to authenticated
using (
  public.has_production_store_access()
  and created_by = (select auth.uid())
  and handoff_status = 'pending_details'
)
with check (
  public.has_production_store_access()
  and created_by = (select auth.uid())
  and handoff_status = 'pending_details'
);

create or replace function public.notify_delivery_goods_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_notify boolean := false;
begin
  if new.handoff_status = 'pending_details' and new.salesperson_id is not null then
    if tg_op = 'INSERT' then
      should_notify := true;
    else
      should_notify := old.goods_status is distinct from new.goods_status;
    end if;
    if should_notify then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(
        new.salesperson_id,
        'delivery_goods_status',
        new.id,
        'delivery_goods_status:' || new.id || ':' || pg_catalog.clock_timestamp()
      )
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists deliveries_goods_status_notification_after_change on public.deliveries;
create trigger deliveries_goods_status_notification_after_change
after insert or update on public.deliveries
for each row execute function public.notify_delivery_goods_status();
