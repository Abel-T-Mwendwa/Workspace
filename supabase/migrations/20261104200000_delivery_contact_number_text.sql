begin;

alter table public.deliveries
  drop constraint if exists deliveries_contact_number_check;

alter table public.deliveries
  drop constraint if exists deliveries_handoff_required_fields_check;

alter table public.deliveries
  add constraint deliveries_handoff_required_fields_check check (
    handoff_status = 'pending_details'
    or (
      client_name is not null and length(btrim(client_name)) between 1 and 160
      and delivery_date is not null
      and (
        production_status = 'Ready'
        or (
          contact_name is not null and length(btrim(contact_name)) between 1 and 160
          and contact_number is not null and length(btrim(contact_number)) > 0
        )
      )
    )
  );

commit;

select tgname, tgenabled from pg_trigger where tgrelid = 'public.deliveries'::regclass and not tgisinternal;
