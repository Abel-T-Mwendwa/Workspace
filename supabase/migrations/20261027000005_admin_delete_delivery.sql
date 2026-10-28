create or replace function public.admin_delete_delivery(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if not exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role::text = 'admin'
      and active
  ) then
    raise exception 'Administrator access is required.';
  end if;
  if p_delivery_id is null then
    raise exception 'A delivery is required.';
  end if;

  delete from public.portal_notifications
  where related_id = p_delivery_id
    and notification_type in ('delivery_new', 'delivery_ready', 'delivery_delivered');

  delete from public.deliveries
  where id = p_delivery_id;
  get diagnostics deleted_count = row_count;
  if deleted_count = 0 then
    raise exception 'Delivery not found.';
  end if;
end
$$;

revoke all on function public.admin_delete_delivery(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_delivery(uuid) to authenticated;
