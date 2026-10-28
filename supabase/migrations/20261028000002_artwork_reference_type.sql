alter table public.artwork_requests
  add column if not exists reference_type text;

alter table public.artwork_requests
  add column if not exists previous_reference text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'artwork_requests_reference_type_check'
      and conrelid = 'public.artwork_requests'::regclass
  ) then
    alter table public.artwork_requests
      add constraint artwork_requests_reference_type_check
      check (reference_type in ('new', 'old'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'artwork_requests_reference_type_consistency'
      and conrelid = 'public.artwork_requests'::regclass
  ) then
    alter table public.artwork_requests
      add constraint artwork_requests_reference_type_consistency
      check (
        reference_type is null
        or reference_type = 'new'
        or (
          reference_type = 'old'
          and previous_reference is not null
          and previous_reference <> ''
        )
      );
  end if;
end
$$;
