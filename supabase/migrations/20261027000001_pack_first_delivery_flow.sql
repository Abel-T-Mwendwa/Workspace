alter table public.deliveries
  drop constraint if exists deliveries_status_timestamps_check;

alter table public.deliveries
  add constraint deliveries_status_timestamps_check check (
    ((production_status = 'Not ready' and ready_at is null)
      or (production_status = 'Ready' and ready_at is not null))
    and ((dispatch_status = 'Not delivered' and delivered_at is null)
      or (dispatch_status = 'Delivered' and delivered_at is not null
        and dispatched_at is not null and production_status = 'Ready'))
    and (dispatch_status <> 'Delivered' or transport is not null)
    and (dispatch_status <> 'Delivered' or transport <> 'Company' or vehicle_id is not null)
  );

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
  elsif actor_role = 'production' then
    if (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.client_name,
        new.contact_name, new.contact_number, new.items, new.delivery_time, new.delivery_date,
        new.special_instruction, new.dispatch_status, new.dispatched_at, new.delivered_at,
        new.transport, new.vehicle_id)
       is distinct from
       (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.client_name,
        old.contact_name, old.contact_number, old.items, old.delivery_time, old.delivery_date,
        old.special_instruction, old.dispatch_status, old.dispatched_at, old.delivered_at,
        old.transport, old.vehicle_id)
      or old.production_status <> 'Not ready' or new.production_status <> 'Ready' then
      raise exception 'Production may only mark a request Ready once';
    end if;
    new.ready_at := now();
    return new;
  elsif actor_role = 'dispatch' then
    if old.production_status <> 'Ready'
      or new.production_status is distinct from old.production_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.client_name,
          new.contact_name, new.contact_number, new.items, new.delivery_time, new.delivery_date,
          new.special_instruction, new.ready_at)
         is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.client_name,
          old.contact_name, old.contact_number, old.items, old.delivery_time, old.delivery_date,
          old.special_instruction, old.ready_at) then
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
        raise exception 'Choose Client or Company transport';
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
