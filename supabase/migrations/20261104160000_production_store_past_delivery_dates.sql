begin;

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
  if new.handoff_status is distinct from 'pending_details'
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

commit;

select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.deliveries'::regclass
  and not tgisinternal;
