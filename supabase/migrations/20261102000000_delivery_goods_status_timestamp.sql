alter table public.deliveries
  add column if not exists goods_status_updated_at timestamptz;

update public.deliveries
set goods_status_updated_at = created_at
where goods_status_updated_at is null;

create or replace function public.set_delivery_goods_status_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.goods_status_updated_at := case
      when new.goods_status is not null then now()
      else null
    end;
  elsif new.goods_status is distinct from old.goods_status then
    new.goods_status_updated_at := case
      when new.goods_status is not null then now()
      else null
    end;
  end if;
  return new;
end
$$;

drop trigger if exists deliveries_goods_status_timestamp_before_insert on public.deliveries;
create trigger deliveries_goods_status_timestamp_before_insert
before insert on public.deliveries
for each row execute function public.set_delivery_goods_status_updated_at();

drop trigger if exists deliveries_goods_status_timestamp_before_update on public.deliveries;
create trigger deliveries_goods_status_timestamp_before_update
before update on public.deliveries
for each row execute function public.set_delivery_goods_status_updated_at();
