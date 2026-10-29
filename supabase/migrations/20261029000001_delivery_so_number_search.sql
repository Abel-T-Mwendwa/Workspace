create or replace function public.delivery_so_numbers_search_text(value jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(pg_catalog.string_agg(item ->> 'so_number', ' '), '')
  from pg_catalog.jsonb_array_elements(coalesce(value, '[]'::jsonb)) as lines(item)
$$;

alter table public.deliveries
  add column if not exists so_numbers_search text
  generated always as (public.delivery_so_numbers_search_text(items)) stored;

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
  vehicle_id,
  so_numbers_search
from public.deliveries;
