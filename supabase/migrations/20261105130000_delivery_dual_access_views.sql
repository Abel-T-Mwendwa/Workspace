begin;

create or replace function public.guard_delivery_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
end;
$$;

drop policy if exists "hide pending handoffs from delivery operations" on public.deliveries;
create policy "hide pending handoffs from delivery operations" on public.deliveries
as restrictive for select to authenticated using (
  public.current_role()::text not in ('production', 'dispatch')
  or public.has_production_access()
  or public.has_dispatch_access()
);

commit;

select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.deliveries'::regclass
  and not tgisinternal;
