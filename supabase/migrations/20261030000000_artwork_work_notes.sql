create table if not exists public.artwork_work_notes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.artwork_requests(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null default auth.uid(),
  author_name text not null,
  author_role text not null check (author_role in ('designer', 'salesperson')),
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists artwork_work_notes_request_created_idx
  on public.artwork_work_notes (request_id, created_at);

alter table public.artwork_work_notes enable row level security;

drop policy if exists "Work note participants read notes" on public.artwork_work_notes;
create policy "Work note participants read notes" on public.artwork_work_notes
  for select to authenticated using (
    public.is_admin()
    or exists (
      select 1 from public.artwork_requests a
      where a.id = request_id
        and (
          (public.current_role()::text = 'salesperson' and a.created_by = (select auth.uid()))
          or (public.current_role()::text = 'designer'
            and (a.assigned_designer = (select auth.uid()) or a.assigned_designer is null))
        )
    )
  );

drop policy if exists "Work note participants add notes" on public.artwork_work_notes;
create policy "Work note participants add notes" on public.artwork_work_notes
  for insert to authenticated with check (
    author_id = (select auth.uid())
    and (
      public.is_admin()
      or exists (
        select 1 from public.artwork_requests a
        where a.id = request_id
          and (
            (public.current_role()::text = 'salesperson'
              and author_role = 'salesperson' and a.created_by = (select auth.uid()))
            or (public.current_role()::text = 'designer'
              and author_role = 'designer' and a.assigned_designer = (select auth.uid()))
          )
      )
    )
  );

drop policy if exists "Admins manage work notes" on public.artwork_work_notes;
create policy "Admins manage work notes" on public.artwork_work_notes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.artwork_work_notes to authenticated;

create or replace function public.set_artwork_work_note_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.author_id := auth.uid();
    select p.full_name into new.author_name from public.profiles p where p.id = auth.uid();
    if public.current_role()::text in ('designer', 'salesperson') then
      new.author_role := public.current_role()::text;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists artwork_work_note_set_author on public.artwork_work_notes;
create trigger artwork_work_note_set_author
before insert on public.artwork_work_notes
for each row execute function public.set_artwork_work_note_author();

insert into public.artwork_work_notes (request_id, author_id, author_name, author_role, message, created_at)
select a.id, a.assigned_designer, coalesce(p.full_name, 'Designer'), 'designer',
       btrim(a.designer_notes), a.created_at
from public.artwork_requests a
left join public.profiles p on p.id = a.assigned_designer
where nullif(btrim(a.designer_notes), '') is not null
  and not exists (
    select 1 from public.artwork_work_notes n
    where n.request_id = a.id and n.author_role = 'designer'
      and n.message = btrim(a.designer_notes)
      and n.author_id is not distinct from a.assigned_designer
  );

create or replace function public.notify_artwork_work_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row record;
  recipient uuid;
  notification_type text;
begin
  select a.created_by, a.assigned_designer into request_row
  from public.artwork_requests a where a.id = new.request_id;

  if new.author_role = 'designer' then
    recipient := request_row.created_by;
    notification_type := 'artwork_work_note_designer';
  else
    recipient := request_row.assigned_designer;
    notification_type := 'artwork_work_note_salesperson';
  end if;

  if recipient is not null and recipient <> new.author_id then
    insert into public.portal_notifications (recipient_id, notification_type, related_id, event_key)
    values (recipient, notification_type, new.request_id, 'artwork_work_note:' || new.id::text)
    on conflict (event_key) do nothing;
  end if;
  return new;
end
$$;

drop trigger if exists artwork_work_note_notify_participant on public.artwork_work_notes;
create trigger artwork_work_note_notify_participant
after insert on public.artwork_work_notes
for each row execute function public.notify_artwork_work_note();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'artwork_work_notes'
  ) then
    alter publication supabase_realtime add table public.artwork_work_notes;
  end if;
end
$$;
