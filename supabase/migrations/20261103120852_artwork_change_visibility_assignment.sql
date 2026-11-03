begin;

drop policy if exists "Designers read visible changes" on public.artwork_changes;
create policy "Designers read visible changes" on public.artwork_changes
  for select to authenticated using (
    public.current_role() = 'designer'::public.app_role
    and exists (
      select 1 from public.artwork_requests a
      where a.id = artwork_id
    )
  );

create or replace function public.after_artwork_change_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_assigned_designer uuid;
  v_preferred_designer uuid;
  v_preference_recorded boolean;
  v_notification_designer uuid;
begin
  select a.assigned_designer, a.preferred_designer, a.preferred_designer_recorded
    into v_assigned_designer, v_preferred_designer, v_preference_recorded
    from public.artwork_requests a
    where a.id = new.artwork_id;

  if v_preference_recorded then
    v_notification_designer := v_preferred_designer;
  else
    v_notification_designer := v_assigned_designer;
  end if;

  perform set_config('app.system_change', 'on', true);
  update public.artwork_requests
    set assigned_designer = case
          when v_preference_recorded then v_preferred_designer
          else v_assigned_designer
        end,
        status = 'Change requested'::public.artwork_status,
        claimed_at = null,
        done_at = null,
        done_by = null,
        updated_at = now()
    where id = new.artwork_id;
  perform set_config('app.system_change', 'off', true);

  update public.designer_notifications
    set read_at = now()
    where artwork_id = new.artwork_id and read_at is null;

  if v_notification_designer is null then
    insert into public.designer_notifications (artwork_id, designer_id)
      select new.artwork_id, p.id
      from public.profiles p
      where p.role = 'designer'::public.app_role and p.active;
  else
    insert into public.designer_notifications (artwork_id, designer_id)
      values (new.artwork_id, v_notification_designer);
  end if;

  return new;
end
$$;

commit;
