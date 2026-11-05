begin;

alter table public.profiles
  add column if not exists production_access boolean not null default false,
  add column if not exists dispatch_access boolean not null default false;

create or replace function public.has_production_access()
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
      and p.role::text <> 'admin'
      and (p.role::text = 'production' or p.production_access)
  )
$$;

create or replace function public.has_dispatch_access()
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
      and p.role::text <> 'admin'
      and (p.role::text = 'dispatch' or p.dispatch_access)
  )
$$;

revoke all on function public.has_production_access() from public, anon;
revoke all on function public.has_dispatch_access() from public, anon;
grant execute on function public.has_production_access() to authenticated;
grant execute on function public.has_dispatch_access() to authenticated;

create or replace function public.guard_profile_access_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.production_access is distinct from old.production_access
    or new.dispatch_access is distinct from old.dispatch_access
    or new.production_store_access is distinct from old.production_store_access
    or new.route_admin_access is distinct from old.route_admin_access
  ) and coalesce(auth.role(), '') <> 'service_role'
    and not public.is_admin() then
    raise exception 'Only administrators may change profile access flags';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_access_flags
before update on public.profiles
for each row execute function public.guard_profile_access_flags();

create or replace function public.audit_profile_access_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
begin
  if new.production_access is distinct from old.production_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'production_access', 'old', old.production_access, 'new', new.production_access));
  end if;
  if new.dispatch_access is distinct from old.dispatch_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'dispatch_access', 'old', old.dispatch_access, 'new', new.dispatch_access));
  end if;
  if new.production_store_access is distinct from old.production_store_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'production_store_access', 'old', old.production_store_access, 'new', new.production_store_access));
  end if;
  if new.route_admin_access is distinct from old.route_admin_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'route_admin_access', 'old', old.route_admin_access, 'new', new.route_admin_access));
  end if;
  return new;
end;
$$;

create trigger profiles_audit_access_flags
after update on public.profiles
for each row execute function public.audit_profile_access_flags();

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
  elsif actor_role = 'salesperson'
    and not (public.has_production_access()
      and (new.production_status is distinct from old.production_status
        or new.ready_at is distinct from old.ready_at))
    and not (public.has_dispatch_access()
      and (new.dispatch_status is distinct from old.dispatch_status
        or new.dispatched_at is distinct from old.dispatched_at
        or new.delivered_at is distinct from old.delivered_at
        or new.delivery_date is distinct from old.delivery_date
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id)) then
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
    and (new.production_status is distinct from old.production_status
      or new.ready_at is distinct from old.ready_at) then
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
    and (new.dispatch_status is distinct from old.dispatch_status
      or new.dispatched_at is distinct from old.dispatched_at
      or new.delivered_at is distinct from old.delivered_at
      or new.delivery_date is distinct from old.delivery_date
      or new.transport is distinct from old.transport
      or new.vehicle_id is distinct from old.vehicle_id) then
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
end;
$$;

drop policy if exists "delivery role read" on public.deliveries;
create policy "delivery role read" on public.deliveries
for select to authenticated using (
  public.current_role()::text = 'admin'
  or (public.current_role()::text = 'salesperson' and created_by = (select auth.uid()))
  or public.has_production_access()
  or public.has_dispatch_access()
);

drop policy if exists "production mark ready" on public.deliveries;
create policy "production mark ready" on public.deliveries
for update to authenticated using (
  public.has_production_access() and production_status = 'Not ready'
) with check (
  public.has_production_access() and production_status = 'Ready'
);

drop policy if exists "dispatch update ready delivery" on public.deliveries;
create policy "dispatch update ready delivery" on public.deliveries
for update to authenticated using (
  public.has_dispatch_access() and production_status = 'Ready'
) with check (
  public.has_dispatch_access() and production_status = 'Ready'
);

drop policy if exists "hide pending handoffs from delivery operations" on public.deliveries;
create policy "hide pending handoffs from delivery operations" on public.deliveries
as restrictive for select to authenticated using (
  (not public.has_production_access() and not public.has_dispatch_access())
  or public.has_production_access()
  or handoff_status <> 'pending_details'
  or (public.has_production_store_access() and created_by = (select auth.uid()))
  or (public.has_dispatch_access() and production_status = 'Ready')
);

drop policy if exists "dispatch read vehicles" on public.vehicles;
create policy "dispatch read vehicles" on public.vehicles
for select to authenticated using (
  public.current_role()::text = 'admin'
  or public.has_dispatch_access()
  or public.has_production_access()
);

drop policy if exists "dispatch manage vehicles" on public.vehicles;
create policy "dispatch manage vehicles" on public.vehicles
for all to authenticated using (
  public.current_role()::text = 'admin' or public.has_dispatch_access()
) with check (
  public.current_role()::text = 'admin' or public.has_dispatch_access()
);

create or replace view public.deliveries_role_safe
with (security_invoker = true)
as
select
  id,
  sr,
  ref_no,
  created_at,
  created_by,
  salesperson_id,
  handoff_status,
  goods_status,
  client_name,
  case
    when public.has_production_access() or public.has_dispatch_access() then null::text
    else contact_name
  end as contact_name,
  case
    when public.has_production_access() or public.has_dispatch_access() then null::text
    else contact_number
  end as contact_number,
  items,
  delivery_time,
  delivery_time_any,
  delivery_date,
  special_instruction,
  production_status,
  dispatch_status,
  ready_at,
  dispatched_at,
  delivered_at,
  transport,
  vehicle_id,
  so_numbers_search
from public.deliveries;

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
begin
  if tg_op = 'INSERT' then
    for recipient in
      select p.id from public.profiles p
      where p.active and p.role::text <> 'admin'
        and (p.role::text = 'production' or p.production_access)
    loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, 'delivery_new', new.id, 'delivery_new:' || new.id || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
    return new;
  end if;
  if old.production_status is distinct from new.production_status and new.production_status = 'Ready' then
    event_name := 'delivery_ready';
    event_time := new.ready_at;
    for recipient in
      select p.id from public.profiles p
      where p.active and p.role::text <> 'admin'
        and (p.role::text = 'dispatch' or p.dispatch_access)
    loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, event_name, new.id, event_name || ':' || new.id || ':' || event_time || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
  end if;
  if old.dispatched_at is distinct from new.dispatched_at and new.dispatched_at is not null then
    insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
    values(new.created_by, 'delivery_dispatched', new.id, 'delivery_dispatched:' || new.id || ':' || new.dispatched_at)
    on conflict(event_key) do nothing;
  end if;
  if old.dispatch_status is distinct from new.dispatch_status and new.dispatch_status = 'Delivered' then
    insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
    values(new.created_by, 'delivery_delivered', new.id, 'delivery_delivered:' || new.id || ':' || new.delivered_at)
    on conflict(event_key) do nothing;
  end if;
  return new;
end;
$$;

commit;

select c.relname as table_name, t.tgname, t.tgenabled
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
where t.tgrelid in ('public.deliveries'::regclass, 'public.profiles'::regclass)
  and not t.tgisinternal
order by c.relname, t.tgname;
