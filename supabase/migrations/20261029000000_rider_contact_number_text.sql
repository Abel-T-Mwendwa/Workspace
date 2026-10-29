alter table public.rider_jobs
  drop constraint if exists rider_jobs_contact_number_check,
  add constraint rider_jobs_contact_number_length_check
    check (length(btrim(contact_number)) between 1 and 100);
