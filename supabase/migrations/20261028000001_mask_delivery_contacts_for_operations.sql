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
    when public.current_role()::text in ('production', 'dispatch') then null::text
    else contact_name
  end as contact_name,
  case
    when public.current_role()::text in ('production', 'dispatch') then null::text
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
  vehicle_id
from public.deliveries;

revoke all on public.deliveries_role_safe from public, anon;
grant select on public.deliveries_role_safe to authenticated;
