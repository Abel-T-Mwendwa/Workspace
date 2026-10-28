alter table public.deliveries
  add column if not exists delivery_time_any boolean;
