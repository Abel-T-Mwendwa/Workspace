begin;

create or replace function public.notify_delivery_goods_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_notify boolean := false;
  missing_address boolean;
  urgent boolean;
begin
  missing_address := not exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) as line(item)
    where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
  );
  urgent := missing_address
    and new.goods_status = 'ready'
    and new.production_status = 'Ready'
    and new.dispatch_status = 'Not delivered';

  if new.handoff_status = 'pending_details' and new.salesperson_id is not null then
    if tg_op = 'INSERT' then
      should_notify := not missing_address;
    else
      should_notify := old.goods_status is distinct from new.goods_status
        and not (missing_address and (urgent or new.salesperson_id is distinct from old.salesperson_id));
    end if;
    if should_notify then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(
        new.salesperson_id,
        'delivery_goods_status',
        new.id,
        'delivery_goods_status:' || new.id || ':' || pg_catalog.clock_timestamp()
      )
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;

create or replace function public.notify_delivery_address_levels()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  missing_address boolean;
  details_needed boolean;
  urgent boolean;
  old_missing_address boolean := false;
  old_details_needed boolean := false;
  old_urgent boolean := false;
  salesperson_changed boolean := false;
  event_time timestamptz := pg_catalog.clock_timestamp();
  notification_type text;
begin
  missing_address := not exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) as line(item)
    where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
  );
  details_needed := missing_address
    and new.dispatch_status is distinct from 'Delivered'
    and new.delivered_at is null;
  urgent := missing_address
    and new.goods_status = 'ready'
    and new.production_status = 'Ready'
    and new.dispatch_status = 'Not delivered';

  if tg_op = 'UPDATE' then
    old_missing_address := not exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(old.items, '[]'::jsonb)) as line(item)
      where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
    );
    old_details_needed := old_missing_address
      and old.dispatch_status is distinct from 'Delivered'
      and old.delivered_at is null;
    old_urgent := old_missing_address
      and old.goods_status = 'ready'
      and old.production_status = 'Ready'
      and old.dispatch_status = 'Not delivered';
    salesperson_changed := new.salesperson_id is distinct from old.salesperson_id;
  end if;

  if new.salesperson_id is not null then
    if tg_op = 'INSERT' then
      notification_type := case when urgent then 'delivery_address_urgent'
        when details_needed then 'delivery_details_needed' end;
    elsif salesperson_changed then
      notification_type := case when urgent then 'delivery_address_urgent'
        when details_needed then 'delivery_details_needed' end;
    elsif urgent and not old_urgent then
      notification_type := 'delivery_address_urgent';
    elsif details_needed and not old_details_needed then
      notification_type := 'delivery_details_needed';
    end if;

    if notification_type is not null then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(
        new.salesperson_id,
        notification_type,
        new.id,
        notification_type || ':' || new.id || ':' || event_time || ':' || new.salesperson_id
      )
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists deliveries_address_levels_notification_after_change on public.deliveries;
create trigger deliveries_address_levels_notification_after_change
after insert or update on public.deliveries
for each row execute function public.notify_delivery_address_levels();

commit;

select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.deliveries'::regclass
  and not tgisinternal;
