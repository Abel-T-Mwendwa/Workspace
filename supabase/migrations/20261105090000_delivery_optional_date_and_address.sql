begin;

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
  elsif actor_role = 'salesperson' then
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
  elsif actor_role = 'production' then
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
  elsif actor_role = 'dispatch' then
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
  end if;
  raise exception 'Not authorized to update delivery requests';
end
$$;

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
  if actor_role not in ('salesperson', 'dispatch')
    and new.handoff_status is distinct from 'pending_details'
    and new.delivery_date is not null
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

alter table public.deliveries
  drop constraint if exists deliveries_handoff_required_fields_check;

alter table public.deliveries
  add constraint deliveries_handoff_required_fields_check check (
    handoff_status = 'pending_details'
    or production_status = 'Ready'
    or (
      client_name is not null and length(btrim(client_name)) between 1 and 160
      and delivery_date is not null
      and contact_name is not null and length(btrim(contact_name)) between 1 and 160
      and contact_number is not null and length(btrim(contact_number)) > 0
    )
  );

commit;

select tgname, tgenabled from pg_trigger where tgrelid = 'public.deliveries'::regclass and not tgisinternal;
