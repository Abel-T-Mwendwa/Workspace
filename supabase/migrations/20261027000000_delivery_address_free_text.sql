create or replace function public.valid_delivery_items(value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  item jsonb;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array'
    or pg_catalog.jsonb_array_length(value) = 0 then
    return false;
  end if;
  for item in select pg_catalog.jsonb_array_elements(value)
  loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) = 0
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) > 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) = 0
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) > 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'address')), 0) = 0
      or coalesce((item ->> 'quantity')::integer, 0) < 1 then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$$;
