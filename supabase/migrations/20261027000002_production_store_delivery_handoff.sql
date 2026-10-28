alter type public.app_role add value if not exists 'production_store';

alter table public.profiles
  add column if not exists production_store_access boolean not null default false;

update public.profiles
set production_store_access = true
where role::text = 'production_store' and production_store_access = false;

create or replace function public.has_production_store_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and (p.role::text = 'production_store' or p.production_store_access)
  )
$$;

revoke all on function public.has_production_store_access() from public, anon;
grant execute on function public.has_production_store_access() to authenticated;

alter table public.deliveries
  add column if not exists salesperson_id uuid references public.profiles(id),
  add column if not exists handoff_status text not null default 'requested'
    check (handoff_status in ('pending_details', 'requested'));

alter table public.deliveries
  alter column client_name drop not null,
  alter column contact_name drop not null,
  alter column contact_number drop not null,
  alter column delivery_time drop not null,
  alter column delivery_date drop not null;

create or replace function public.valid_production_delivery_items(value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item jsonb;
  quantity_value text;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array'
    or pg_catalog.jsonb_array_length(value) = 0 then
    return false;
  end if;
  for item in select pg_catalog.jsonb_array_elements(value)
  loop
    quantity_value := nullif(pg_catalog.btrim(item ->> 'quantity'), '');
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) not between 1 and 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) > 200
      or coalesce(pg_catalog.length(item ->> 'address'), 0) > 200
      or (quantity_value is not null and quantity_value !~ '^[1-9][0-9]{0,4}$')
      or coalesce(item ->> 'goods_status', '') not in ('ready', 'partial', 'not_ready') then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$$;

alter table public.deliveries drop constraint if exists deliveries_items_check;
alter table public.deliveries add constraint deliveries_items_check check (
  (handoff_status = 'pending_details' and public.valid_production_delivery_items(items))
  or (handoff_status = 'requested' and public.valid_delivery_items(items))
);

alter table public.deliveries
  drop constraint if exists deliveries_handoff_required_fields_check;
alter table public.deliveries
  add constraint deliveries_handoff_required_fields_check check (
    handoff_status = 'pending_details'
    or (
      client_name is not null and length(btrim(client_name)) between 1 and 160
      and contact_name is not null and length(btrim(contact_name)) between 1 and 160
      and contact_number is not null and contact_number ~ '^\+?[0-9][0-9 ()-]{6,30}$'
      and delivery_date is not null
    )
  );

create or replace function public.prepare_delivery_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := public.current_role()::text;
begin
  if new.handoff_status = 'pending_details' then
    if not public.has_production_store_access() or new.created_by <> (select auth.uid())
      or new.salesperson_id is null or not exists (
        select 1 from public.profiles p
        where p.id = new.salesperson_id and p.role::text = 'salesperson' and p.active
      ) then
      raise exception 'Production store entries require an active assigned salesperson';
    end if;
  elsif actor_role not in ('salesperson', 'admin')
    or (actor_role = 'salesperson' and new.created_by <> (select auth.uid())) then
    raise exception 'Only a salesperson may submit their own delivery request';
  elsif actor_role = 'salesperson' then
    new.salesperson_id := (select auth.uid());
  end if;
  if new.delivery_date is not null
    and new.delivery_date < (now() at time zone 'Africa/Nairobi')::date then
    raise exception 'Delivery date cannot be in the past';
  end if;
  new.id := coalesce(new.id, gen_random_uuid());
  new.created_at := now();
  new.ref_no := public.next_portal_ref('DL');
  new.production_status := 'Not ready';
  new.dispatch_status := 'Not delivered';
  new.ready_at := null;
  new.dispatched_at := null;
  new.delivered_at := null;
  new.transport := null;
  new.vehicle_id := null;
  return new;
end
$$;

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

drop policy if exists "production store read own deliveries" on public.deliveries;
create policy "production store read own deliveries" on public.deliveries
for select to authenticated using (
  public.has_production_store_access() and created_by = (select auth.uid())
);

drop policy if exists "salesperson read assigned deliveries" on public.deliveries;
create policy "salesperson read assigned deliveries" on public.deliveries
for select to authenticated using (
  public.current_role()::text = 'salesperson' and salesperson_id = (select auth.uid())
);

drop policy if exists "production store create assigned delivery" on public.deliveries;
create policy "production store create assigned delivery" on public.deliveries
for insert to authenticated with check (
  public.has_production_store_access()
  and created_by = (select auth.uid())
  and handoff_status = 'pending_details'
  and salesperson_id is not null
  and exists (
    select 1 from public.profiles p
    where p.id = salesperson_id and p.role::text = 'salesperson' and p.active
  )
);

drop policy if exists "assigned salesperson complete delivery" on public.deliveries;
create policy "assigned salesperson complete delivery" on public.deliveries
for update to authenticated using (
  public.current_role()::text = 'salesperson'
  and salesperson_id = (select auth.uid())
  and handoff_status = 'pending_details'
) with check (
  public.current_role()::text = 'salesperson'
  and salesperson_id = (select auth.uid())
  and handoff_status = 'requested'
);

drop policy if exists "hide pending handoffs from delivery operations" on public.deliveries;
create policy "hide pending handoffs from delivery operations" on public.deliveries
as restrictive for select to authenticated using (
  public.current_role()::text not in ('production', 'dispatch')
  or handoff_status <> 'pending_details'
  or (public.has_production_store_access() and created_by = (select auth.uid()))
);

create or replace function public.notify_delivery_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient record;
  event_name text;
  event_time timestamptz;
  recipient_user uuid;
begin
  if tg_op = 'INSERT' then
    if new.handoff_status = 'pending_details' then return new; end if;
    for recipient in select p.id from public.profiles p where p.role::text = 'production' and p.active loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, 'delivery_new', new.id, 'delivery_new:' || new.id || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
    return new;
  end if;
  if old.handoff_status = 'pending_details' and new.handoff_status = 'requested' then
    for recipient in select p.id from public.profiles p where p.role::text = 'production' and p.active loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, 'delivery_new', new.id, 'delivery_new:' || new.id || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
  end if;
  if old.production_status is distinct from new.production_status and new.production_status = 'Ready' then
    event_name := 'delivery_ready';
    event_time := new.ready_at;
    for recipient in select p.id from public.profiles p where p.role::text = 'dispatch' and p.active loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, event_name, new.id, event_name || ':' || new.id || ':' || event_time || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
  end if;
  if old.dispatch_status is distinct from new.dispatch_status and new.dispatch_status = 'Delivered' then
    recipient_user := coalesce(new.salesperson_id, new.created_by);
    insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
    values(recipient_user, 'delivery_delivered', new.id, 'delivery_delivered:' || new.id || ':' || new.delivered_at)
    on conflict(event_key) do nothing;
  end if;
  return new;
end
$$;
