alter table public.rider_jobs
  alter column expected_time drop not null;

create or replace function public.prepare_rider_job_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text := public.current_role()::text;
  has_request_access boolean;
begin
  has_request_access := actor_role = 'user' or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.rider_request_access is true
  );
  if (actor_role not in ('salesperson', 'admin') and not has_request_access)
    or (actor_role = 'salesperson' and new.created_by <> auth.uid())
    or (actor_role <> 'admin' and has_request_access and new.created_by <> auth.uid()) then
    raise exception 'Only a salesperson may request a rider';
  end if;
  new.id := coalesce(new.id, gen_random_uuid());
  new.created_at := now();
  new.ref_no := public.next_portal_ref('RJ');
  new.assigned_rider := null;
  new.rider_time := null;
  new.rider_time_end := null;
  new.status := 'Not started';
  new.assigned_at := null;
  new.started_at := null;
  new.finished_at := null;
  return new;
end
$$;
