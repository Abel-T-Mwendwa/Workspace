begin;

alter table public.deliveries
  add column if not exists closed_short boolean not null default false,
  add column if not exists closed_short_reason text;

create table if not exists public.store_release_logs (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  item_key text not null,
  qty integer not null check (qty > 0),
  done_on date not null default current_date,
  user_id uuid not null references public.profiles(id),
  note text,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,
  created_at timestamptz not null default now(),
  check (item_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check ((voided_at is null and voided_by is null and void_reason is null)
      or (voided_at is not null and voided_by is not null and nullif(btrim(void_reason), '') is not null))
);

create table if not exists public.dispatch_receipt_logs (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  item_key text not null,
  qty integer not null check (qty > 0),
  done_on date not null default current_date,
  user_id uuid not null references public.profiles(id),
  note text,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,
  created_at timestamptz not null default now(),
  check (item_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check ((voided_at is null and voided_by is null and void_reason is null)
      or (voided_at is not null and voided_by is not null and nullif(btrim(void_reason), '') is not null))
);

create table if not exists public.dispatch_trips (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  vehicle text not null,
  rider_id uuid references public.profiles(id),
  status text not null default 'Packed'
    check (status in ('Packed', 'Out for delivery', 'Delivered', 'Failed')),
  delivered_on date,
  delivery_address text,
  note text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,
  unique (id, delivery_id),
  check ((voided_at is null and voided_by is null and void_reason is null)
      or (voided_at is not null and voided_by is not null and nullif(btrim(void_reason), '') is not null))
);

create table if not exists public.dispatch_trip_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null,
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  item_key text not null,
  qty_packed integer not null check (qty_packed > 0),
  qty_delivered integer not null default 0 check (qty_delivered >= 0),
  check (item_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  foreign key (trip_id, delivery_id) references public.dispatch_trips(id, delivery_id) on delete restrict,
  unique (trip_id, item_key)
);

create table if not exists public.item_qty_changes (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  item_key text not null,
  old_qty integer not null,
  new_qty integer not null,
  user_id uuid not null references public.profiles(id),
  changed_at timestamptz not null default now(),
  check (item_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

create index if not exists store_release_logs_item_idx
  on public.store_release_logs (delivery_id, item_key) where voided_at is null;
create index if not exists dispatch_receipt_logs_item_idx
  on public.dispatch_receipt_logs (delivery_id, item_key) where voided_at is null;
create index if not exists dispatch_trips_delivery_idx
  on public.dispatch_trips (delivery_id, status) where voided_at is null;
create index if not exists dispatch_trip_items_item_idx
  on public.dispatch_trip_items (delivery_id, item_key);
create index if not exists item_qty_changes_item_idx
  on public.item_qty_changes (delivery_id, item_key, changed_at desc);

create or replace function public.partial_safe_int(value text)
returns integer
language plpgsql
immutable
parallel safe
set search_path to ''
as $function$
declare normalized text := pg_catalog.btrim(value);
begin
  if normalized is null or normalized = '' or normalized !~ '^[0-9]+$' then
    return null;
  end if;
  return normalized::integer;
exception
  when invalid_text_representation or numeric_value_out_of_range then return null;
end
$function$;

create or replace function public.partial_legacy_item_key(delivery_id uuid, item_ordinal bigint)
returns text
language sql
immutable
parallel safe
set search_path to ''
as $function$
  select pg_catalog.substr(digest, 1, 8) || '-' ||
         pg_catalog.substr(digest, 9, 4) || '-' ||
         pg_catalog.substr(digest, 13, 4) || '-' ||
         pg_catalog.substr(digest, 17, 4) || '-' ||
         pg_catalog.substr(digest, 21, 12)
  from (select pg_catalog.md5(delivery_id::text || ':' || item_ordinal::text) as digest) as value
$function$;

create or replace function public.partial_is_admin()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.active and p.role::text = 'admin'
  )
$function$;

create or replace function public.partial_can_read_delivery(target_delivery_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.deliveries d
    join public.profiles p on p.id = (select auth.uid()) and p.active
    where d.id = target_delivery_id
      and (
        p.role::text = 'admin'
        or p.role::text = 'production'
        or p.production_access
        or p.role::text = 'dispatch'
        or p.dispatch_access
        or p.role::text = 'production_store'
        or p.production_store_access
        or (p.role::text = 'salesperson'
          and (d.salesperson_id = p.id or d.created_by = p.id))
      )
  )
$function$;

create or replace view public.delivery_items_expanded
with (security_invoker = true)
as
select
  d.id as delivery_id,
  coalesce(
    lower(nullif(line.item ->> 'item_key', '')),
    public.partial_legacy_item_key(d.id, line.ordinality)
  ) as item_key,
  line.item ->> 'item_name' as item_name,
  line.item ->> 'so_number' as so_number,
  coalesce(public.partial_safe_int(line.item ->> 'quantity'), 0) as job_card_total,
  line.ordinality
from public.deliveries d
cross join lateral pg_catalog.jsonb_array_elements(
  case when pg_catalog.jsonb_typeof(d.items) = 'array' then d.items else '[]'::jsonb end
) with ordinality as line(item, ordinality);

create or replace view public.delivery_item_progress
with (security_invoker = true)
as
with release_totals as (
  select delivery_id, item_key, sum(qty) as released
  from public.store_release_logs
  where voided_at is null
  group by delivery_id, item_key
), receipt_totals as (
  select delivery_id, item_key, sum(qty) as received
  from public.dispatch_receipt_logs
  where voided_at is null
  group by delivery_id, item_key
), trip_totals as (
  select
    ti.delivery_id,
    ti.item_key,
    sum(case
      when t.status = 'Delivered' then ti.qty_delivered
      when t.status in ('Packed', 'Out for delivery') then ti.qty_packed
      else 0
    end) as packed,
    sum(case when t.status = 'Delivered' then ti.qty_delivered else 0 end) as delivered
  from public.dispatch_trip_items ti
  join public.dispatch_trips t on t.id = ti.trip_id
  where t.voided_at is null and t.status <> 'Failed'
  group by ti.delivery_id, ti.item_key
)
select
  item.delivery_id,
  item.item_key,
  item.item_name,
  item.so_number,
  item.job_card_total,
  coalesce(released.released, 0::bigint) as released,
  coalesce(received.received, 0::bigint) as received,
  coalesce(released.released, 0) - coalesce(received.received, 0) as in_production,
  coalesce(trips.packed, 0::bigint) as packed,
  coalesce(trips.delivered, 0::bigint) as delivered,
  greatest(item.job_card_total - coalesce(released.released, 0), 0) as available_to_release,
  greatest(coalesce(released.released, 0) - coalesce(received.received, 0), 0) as available_to_receive,
  greatest(coalesce(received.received, 0) - coalesce(trips.packed, 0), 0) as available_to_pack,
  greatest(item.job_card_total - coalesce(trips.delivered, 0), 0) as balance
from public.delivery_items_expanded item
left join release_totals released using (delivery_id, item_key)
left join receipt_totals received using (delivery_id, item_key)
left join trip_totals trips using (delivery_id, item_key);

create or replace view public.delivery_request_progress
with (security_invoker = true)
as
with totals as (
  select
    d.id as delivery_id,
    d.closed_short,
    coalesce(sum(p.job_card_total), 0) as job_card_total,
    coalesce(sum(p.released), 0) as released,
    coalesce(sum(p.received), 0) as received,
    coalesce(sum(p.in_production), 0) as in_production,
    coalesce(sum(p.packed), 0) as packed,
    coalesce(sum(p.delivered), 0) as delivered,
    coalesce(sum(p.available_to_release), 0) as available_to_release,
    coalesce(sum(p.available_to_receive), 0) as available_to_receive,
    coalesce(sum(p.available_to_pack), 0) as available_to_pack,
    coalesce(sum(p.balance), 0) as balance
  from public.deliveries d
  left join public.delivery_item_progress p on p.delivery_id = d.id
  group by d.id, d.closed_short
)
select
  totals.*,
  case
    when totals.released = 0 then 'Not ready'
    when totals.available_to_release = 0 then 'Ready'
    else 'Partially ready'
  end as goods_status,
  case
    when totals.received = 0 then 'In production'
    when totals.available_to_receive = 0 and totals.released > 0 then 'Fully received'
    else 'Partly received'
  end as production_state,
  case
    when totals.closed_short or totals.balance = 0 then 'Delivered'
    when totals.delivered > 0 then 'Partially delivered'
    else 'Not delivered'
  end as dispatch_state,
  case
    when totals.balance = 0 or totals.closed_short then 'Delivered'
    when totals.received > totals.delivered then 'Dispatch'
    when totals.released > totals.received then 'Production'
    else 'Production store'
  end as board_stage
from totals;

create or replace view public.delivery_partial_constants
with (security_invoker = true)
as
select 3::integer as aging_days;

create or replace function public.partial_prepare_delivery_items()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  old_count integer := 0;
  new_count integer;
  old_keys text[] := array[]::text[];
  normalized_items jsonb := '[]'::jsonb;
  line record;
  old_line record;
  line_key text;
  line_qty integer;
  old_qty integer;
  old_qty_text text;
  key_count integer;
  actor_is_admin boolean;
  actor_is_store boolean;
  actor_is_salesperson boolean;
begin
  if tg_op = 'UPDATE' and new.items is not distinct from old.items then
    return new;
  end if;
  if new.items is null or pg_catalog.jsonb_typeof(new.items) <> 'array' then
    raise exception 'Delivery items must be a JSON array.';
  end if;
  new.id := coalesce(new.id, gen_random_uuid());
  new_count := pg_catalog.jsonb_array_length(new.items);
  if new_count = 0 then
    raise exception 'A delivery must contain at least one item.';
  end if;

  if tg_op = 'UPDATE' then
    old_count := pg_catalog.jsonb_array_length(
      case when pg_catalog.jsonb_typeof(old.items) = 'array' then old.items else '[]'::jsonb end
    );
    for old_line in
      select item, ordinality
      from pg_catalog.jsonb_array_elements(old.items) with ordinality as x(item, ordinality)
    loop
      old_keys := array_append(
        old_keys,
        lower(coalesce(nullif(old_line.item ->> 'item_key', ''),
          public.partial_legacy_item_key(old.id, old_line.ordinality)))
      );
    end loop;
  end if;

  for line in
    select item, ordinality
    from pg_catalog.jsonb_array_elements(new.items) with ordinality as x(item, ordinality)
  loop
    line_key := nullif(line.item ->> 'item_key', '');
    if line_key is not null then
      if line_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Item item_key must be a UUID string.';
      end if;
    end if;
  end loop;

  if tg_op = 'UPDATE' and new_count = old_count then
    for line in
      select item, ordinality
      from pg_catalog.jsonb_array_elements(new.items) with ordinality as x(item, ordinality)
    loop
      line_key := nullif(line.item ->> 'item_key', '');
      if line_key is null then
        line_key := old_keys[line.ordinality];
      elsif not (lower(line_key) = any(old_keys)) then
        raise exception 'An existing item_key cannot be replaced. Keep its key or add a new keyed line.';
      end if;
      normalized_items := normalized_items || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(line.item, '{item_key}', pg_catalog.to_jsonb(lower(line_key)), true)
      );
    end loop;
  elsif tg_op = 'UPDATE' then
    for line in
      select item, ordinality
      from pg_catalog.jsonb_array_elements(new.items) with ordinality as x(item, ordinality)
    loop
      line_key := nullif(line.item ->> 'item_key', '');
      if line_key is null then
        raise exception 'When adding or removing item lines, send item_key for every remaining or existing line.';
      end if;
      normalized_items := normalized_items || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(line.item, '{item_key}', pg_catalog.to_jsonb(lower(line_key)), true)
      );
    end loop;
  else
    for line in
      select item, ordinality
      from pg_catalog.jsonb_array_elements(new.items) with ordinality as x(item, ordinality)
    loop
      line_key := coalesce(nullif(line.item ->> 'item_key', ''), gen_random_uuid()::text);
      normalized_items := normalized_items || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(line.item, '{item_key}', pg_catalog.to_jsonb(lower(line_key)), true)
      );
    end loop;
  end if;

  select count(*) into key_count
  from (
    select item ->> 'item_key'
    from pg_catalog.jsonb_array_elements(normalized_items) as x(item)
    group by item ->> 'item_key'
    having count(*) > 1
  ) duplicate_keys;
  if key_count > 0 then
    raise exception 'Every item line must have a distinct item_key.';
  end if;
  new.items := normalized_items;

  actor_is_admin := public.partial_is_admin();
  actor_is_store := public.has_production_store_access();
  actor_is_salesperson := exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.active and p.role::text = 'salesperson'
  );

  for line in
    select item, ordinality
    from pg_catalog.jsonb_array_elements(new.items) with ordinality as x(item, ordinality)
  loop
    line_qty := public.partial_safe_int(line.item ->> 'quantity');
    if tg_op = 'UPDATE' then
      select item, ordinality into old_line
      from pg_catalog.jsonb_array_elements(old.items) with ordinality as x(item, ordinality)
      where lower(coalesce(nullif(item ->> 'item_key', ''),
        public.partial_legacy_item_key(old.id, ordinality))) = line.item ->> 'item_key'
      limit 1;
    end if;

    if tg_op = 'INSERT'
      or current_setting('workspace.partial_status_sync', true) is distinct from 'on' then
      if tg_op = 'INSERT' or not found then
        if line_qty is null or line_qty < 1 then
          raise exception 'Item quantity must be a positive whole number; blank or non-numeric quantities are not allowed.';
        end if;
        if tg_op = 'INSERT' then
          if not actor_is_admin and not actor_is_store
            and not (actor_is_salesperson and new.created_by = (select auth.uid())) then
            raise exception 'Only production store, an administrator, or a salesperson creating their own request may set item quantity.';
          end if;
        elsif not actor_is_admin and not (
          actor_is_store and old.created_by is distinct from old.salesperson_id
        ) then
          raise exception 'Only production store access or an administrator may add an item to this request.';
        end if;
      else
        old_qty := public.partial_safe_int(old_line.item ->> 'quantity');
        old_qty_text := old_line.item ->> 'quantity';
        if old_qty is distinct from line_qty
          or old_qty_text is distinct from line.item ->> 'quantity' then
          if line_qty is null or line_qty < 1 then
            raise exception 'Item quantity must be a positive whole number; blank or non-numeric quantities are not allowed.';
          end if;
          if not actor_is_admin and not (
            actor_is_store
            and old.created_by is distinct from old.salesperson_id
          ) then
            raise exception 'Only production store access or an administrator may change this job card total.';
          end if;
          if line_qty < coalesce(
            (select sum(r.qty) from public.store_release_logs r
              where r.delivery_id = old.id and r.item_key = line.item ->> 'item_key'
                and r.voided_at is null), 0
          ) then
            raise exception 'Job card total cannot be lower than the quantity already released.';
          end if;
          if (select auth.uid()) is null then
            raise exception 'An authenticated user is required to log a job card total change.';
          end if;
          insert into public.item_qty_changes
            (delivery_id, item_key, old_qty, new_qty, user_id)
          values (old.id, line.item ->> 'item_key', coalesce(old_qty, 0), line_qty, (select auth.uid()));
        end if;
      end if;
    end if;
  end loop;

  if tg_op = 'UPDATE' then
    for line_key in
      select unnest(old_keys)
    loop
      if not exists (
        select 1 from pg_catalog.jsonb_array_elements(new.items) as x(item)
        where item ->> 'item_key' = line_key
      ) and (
        exists (select 1 from public.store_release_logs r where r.delivery_id = old.id and r.item_key = line_key)
        or exists (select 1 from public.dispatch_receipt_logs r where r.delivery_id = old.id and r.item_key = line_key)
        or exists (select 1 from public.dispatch_trip_items t where t.delivery_id = old.id and t.item_key = line_key)
        or exists (select 1 from public.item_qty_changes q where q.delivery_id = old.id and q.item_key = line_key)
      ) then
        raise exception 'An item line with ledger history cannot be removed.';
      elsif not exists (
        select 1 from pg_catalog.jsonb_array_elements(new.items) as x(item)
        where item ->> 'item_key' = line_key
      ) and not actor_is_admin and not (
        actor_is_store and old.created_by is distinct from old.salesperson_id
      ) then
        raise exception 'Only production store access or an administrator may remove an item line.';
      end if;
    end loop;
  end if;
  return new;
end
$function$;

drop trigger if exists deliveries_partial_prepare_items on public.deliveries;
create trigger deliveries_partial_prepare_items
before insert or update on public.deliveries
for each row execute function public.partial_prepare_delivery_items();

create or replace function public.partial_guard_close_with_balance()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.closed_short and not public.partial_is_admin() then
      raise exception 'Only an administrator may close a delivery with balance.';
    end if;
    if new.closed_short and nullif(btrim(new.closed_short_reason), '') is null then
      raise exception 'A close-with-balance reason is required.';
    end if;
    return new;
  end if;
  if new.closed_short is distinct from old.closed_short
    or new.closed_short_reason is distinct from old.closed_short_reason then
    if not public.partial_is_admin() then
      raise exception 'Only an administrator may close a delivery with balance.';
    end if;
    if new.closed_short and nullif(btrim(new.closed_short_reason), '') is null then
      raise exception 'A close-with-balance reason is required.';
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists deliveries_partial_guard_close on public.deliveries;
create trigger deliveries_partial_guard_close
before insert or update on public.deliveries
for each row execute function public.partial_guard_close_with_balance();

create or replace function public.release_item(
  p_delivery_id uuid,
  p_item_key text,
  p_qty integer default null,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_progress record;
  amount integer;
begin
  if not public.partial_is_admin() and not public.has_production_store_access() then
    raise exception 'Production store access or administrator access is required to release items.';
  end if;
  perform 1 from public.deliveries d where d.id = p_delivery_id for update;
  if not found then raise exception 'Delivery not found.'; end if;
  select * into item_progress from public.delivery_item_progress p
  where p.delivery_id = p_delivery_id and p.item_key = p_item_key;
  if not found then raise exception 'Delivery item not found.'; end if;
  amount := coalesce(p_qty, item_progress.available_to_release);
  if amount is null or amount <= 0 then raise exception 'Release quantity must be a positive whole number.'; end if;
  if amount > item_progress.available_to_release
    and not (public.partial_is_admin() and nullif(btrim(p_note), '') is not null) then
    raise exception 'Release quantity exceeds the job card balance; an administrator override requires a note.';
  end if;
  insert into public.store_release_logs (delivery_id, item_key, qty, user_id, note)
  values (p_delivery_id, p_item_key, amount, (select auth.uid()),
    case when amount > item_progress.available_to_release then '[ADMIN OVERRIDE] ' || btrim(p_note) else p_note end);
  return amount;
end
$function$;

create or replace function public.receive_item(
  p_delivery_id uuid,
  p_item_key text,
  p_qty integer default null,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_progress record;
  amount integer;
begin
  if not public.partial_is_admin() and not public.has_dispatch_access() then
    raise exception 'Dispatch access or administrator access is required to receive items.';
  end if;
  perform 1 from public.deliveries d where d.id = p_delivery_id for update;
  if not found then raise exception 'Delivery not found.'; end if;
  select * into item_progress from public.delivery_item_progress p
  where p.delivery_id = p_delivery_id and p.item_key = p_item_key;
  if not found then raise exception 'Delivery item not found.'; end if;
  amount := coalesce(p_qty, item_progress.available_to_receive);
  if amount is null or amount <= 0 then raise exception 'Receive quantity must be a positive whole number.'; end if;
  if amount > item_progress.available_to_receive
    and not (public.partial_is_admin() and nullif(btrim(p_note), '') is not null) then
    raise exception 'Receive quantity exceeds released quantity; an administrator override requires a note.';
  end if;
  insert into public.dispatch_receipt_logs (delivery_id, item_key, qty, user_id, note)
  values (p_delivery_id, p_item_key, amount, (select auth.uid()),
    case when amount > item_progress.available_to_receive then '[ADMIN OVERRIDE] ' || btrim(p_note) else p_note end);
  return amount;
end
$function$;

create or replace function public.pack_to_trip(
  p_delivery_id uuid,
  p_item_key text,
  p_qty integer,
  p_trip_id uuid default null,
  p_vehicle text default null,
  p_rider_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_progress record;
  target_trip uuid;
  trip_row public.dispatch_trips%rowtype;
  existing_item public.dispatch_trip_items%rowtype;
  override_used boolean := false;
begin
  if not public.partial_is_admin() and not public.has_dispatch_access() then
    raise exception 'Dispatch access or administrator access is required to pack items.';
  end if;
  perform 1 from public.deliveries d where d.id = p_delivery_id for update;
  if not found then raise exception 'Delivery not found.'; end if;
  select * into item_progress from public.delivery_item_progress p
  where p.delivery_id = p_delivery_id and p.item_key = p_item_key;
  if not found then raise exception 'Delivery item not found.'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pack quantity must be a positive whole number.'; end if;
  if p_qty > item_progress.available_to_pack then
    if not public.partial_is_admin() or nullif(btrim(p_note), '') is null then
      raise exception 'Pack quantity exceeds quantity received; an administrator override requires a note.';
    end if;
    override_used := true;
  end if;
  if p_trip_id is null then
    if nullif(btrim(p_vehicle), '') is null then raise exception 'A vehicle is required for a new trip.'; end if;
    insert into public.dispatch_trips (delivery_id, vehicle, rider_id, note)
    values (p_delivery_id, btrim(p_vehicle), p_rider_id,
      case when override_used then '[ADMIN OVERRIDE] ' || btrim(p_note) else p_note end)
    returning id into target_trip;
  else
    target_trip := p_trip_id;
    select * into trip_row from public.dispatch_trips t
    where t.id = target_trip and t.delivery_id = p_delivery_id
    for update;
    if not found then raise exception 'Open trip not found for this delivery.'; end if;
    if trip_row.voided_at is not null or trip_row.status not in ('Packed', 'Out for delivery') then
      raise exception 'Only an open trip can receive packed items.';
    end if;
    if p_vehicle is not null and btrim(p_vehicle) <> trip_row.vehicle then
      raise exception 'The vehicle must match the selected trip.';
    end if;
    if override_used then
      update public.dispatch_trips
      set note = concat_ws(E'\n', nullif(note, ''), '[ADMIN OVERRIDE] ' || btrim(p_note))
      where id = target_trip;
    elsif p_note is not null then
      update public.dispatch_trips
      set note = concat_ws(E'\n', nullif(note, ''), btrim(p_note))
      where id = target_trip;
    end if;
  end if;

  select * into existing_item from public.dispatch_trip_items ti
  where ti.trip_id = target_trip and ti.delivery_id = p_delivery_id and ti.item_key = p_item_key
  for update;
  if found then
    update public.dispatch_trip_items
    set qty_packed = qty_packed + p_qty
    where id = existing_item.id;
  else
    insert into public.dispatch_trip_items (trip_id, delivery_id, item_key, qty_packed)
    values (target_trip, p_delivery_id, p_item_key, p_qty);
  end if;
  return target_trip;
end
$function$;

create or replace function public.deliver_trip(
  p_trip_id uuid,
  p_delivered_on date,
  p_delivery_address text,
  p_qty_per_item jsonb default null,
  p_override_note text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  trip_row public.dispatch_trips%rowtype;
  trip_item record;
  target_qty integer;
  qty_text text;
  override_used boolean := false;
  total_target bigint := 0;
begin
  if not public.partial_is_admin() and not public.has_dispatch_access() then
    raise exception 'Dispatch access or administrator access is required to deliver a trip.';
  end if;
  if p_delivered_on is null then raise exception 'A delivery date is required.'; end if;
  if nullif(btrim(p_delivery_address), '') is null then raise exception 'A delivery address is required.'; end if;
  select * into trip_row from public.dispatch_trips t
  where t.id = p_trip_id;
  if not found then raise exception 'Trip not found.'; end if;
  perform 1 from public.deliveries d where d.id = trip_row.delivery_id for update;
  if not found then raise exception 'Delivery not found.'; end if;
  select * into trip_row from public.dispatch_trips t
  where t.id = p_trip_id for update;
  if not found then raise exception 'Trip not found.'; end if;
  if trip_row.voided_at is not null or trip_row.status not in ('Packed', 'Out for delivery') then
    raise exception 'Only an open trip can be delivered.';
  end if;
  if p_qty_per_item is not null and pg_catalog.jsonb_typeof(p_qty_per_item) <> 'object' then
    raise exception 'Per-item delivered quantities must be a JSON object keyed by item_key.';
  end if;
  if p_qty_per_item is not null and exists (
    select 1 from pg_catalog.jsonb_object_keys(p_qty_per_item) supplied(item_key)
    where not exists (
      select 1 from public.dispatch_trip_items ti
      where ti.trip_id = p_trip_id and ti.item_key = supplied.item_key
    )
  ) then
    raise exception 'Delivered quantities contain an item not packed in this trip.';
  end if;
  for trip_item in
    select ti.* from public.dispatch_trip_items ti
    where ti.trip_id = p_trip_id
    order by ti.item_key
    for update
  loop
    if p_qty_per_item is null then
      target_qty := trip_item.qty_packed;
    else
      qty_text := p_qty_per_item ->> trip_item.item_key;
      target_qty := coalesce(public.partial_safe_int(qty_text), 0);
      if qty_text is not null and public.partial_safe_int(qty_text) is null then
        raise exception 'Delivered quantities must be non-negative whole numbers.';
      end if;
    end if;
    if target_qty < 0 then raise exception 'Delivered quantities cannot be negative.'; end if;
    total_target := total_target + target_qty;
    if target_qty > trip_item.qty_packed then
      if not public.partial_is_admin() or nullif(btrim(p_override_note), '') is null then
        raise exception 'Delivered quantity exceeds quantity packed; an administrator override requires a note.';
      end if;
      override_used := true;
    end if;
    if target_qty > 0 and not exists (
      select 1 from public.delivery_item_progress p
      where p.delivery_id = trip_item.delivery_id and p.item_key = trip_item.item_key
    ) then
      raise exception 'Trip item no longer exists on its delivery.';
    end if;
  end loop;
  if total_target = 0 then raise exception 'At least one item must have a positive delivered quantity.'; end if;

  for trip_item in
    select ti.* from public.dispatch_trip_items ti
    where ti.trip_id = p_trip_id
    order by ti.item_key
    for update
  loop
    if p_qty_per_item is null then
      target_qty := trip_item.qty_packed;
    else
      target_qty := coalesce(public.partial_safe_int(p_qty_per_item ->> trip_item.item_key), 0);
    end if;
    update public.dispatch_trip_items
    set qty_delivered = target_qty,
        qty_packed = greatest(qty_packed, target_qty)
    where id = trip_item.id;
  end loop;
  update public.dispatch_trips
  set status = 'Delivered',
      delivered_on = p_delivered_on,
      delivery_address = btrim(p_delivery_address),
      note = case when override_used
        then concat_ws(E'\n', nullif(note, ''), '[ADMIN OVERRIDE] ' || btrim(p_override_note))
        else note end
  where id = p_trip_id;
end
$function$;

create or replace function public.fail_trip(p_trip_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare trip_row public.dispatch_trips%rowtype;
begin
  if not public.partial_is_admin() and not public.has_dispatch_access() then
    raise exception 'Dispatch access or administrator access is required to fail a trip.';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A failure reason is required.'; end if;
  select * into trip_row from public.dispatch_trips t where t.id = p_trip_id;
  if not found then raise exception 'Trip not found.'; end if;
  perform 1 from public.deliveries d where d.id = trip_row.delivery_id for update;
  select * into trip_row from public.dispatch_trips t where t.id = p_trip_id for update;
  if not found then raise exception 'Trip not found.'; end if;
  if trip_row.voided_at is not null or trip_row.status not in ('Packed', 'Out for delivery') then
    raise exception 'Only an open trip can be failed.';
  end if;
  if exists (select 1 from public.dispatch_trip_items ti where ti.trip_id = p_trip_id and ti.qty_delivered > 0) then
    raise exception 'A trip with delivered quantities cannot be failed.';
  end if;
  update public.dispatch_trips
  set status = 'Failed', note = concat_ws(E'\n', nullif(note, ''), 'Failed: ' || btrim(p_reason))
  where id = p_trip_id;
end
$function$;

create or replace function public.void_entry(p_table text, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  target_delivery uuid;
  target_key text;
  release_after bigint;
  received bigint;
  packed bigint;
  trip_id_value uuid;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'A void reason is required.'; end if;
  if (select auth.uid()) is null then raise exception 'Authentication is required.'; end if;

  if p_table = 'store_release_logs' then
    select r.delivery_id, r.item_key into target_delivery, target_key
    from public.store_release_logs r where r.id = p_id and r.voided_at is null;
    if not found then raise exception 'Active release entry not found.'; end if;
    if not public.partial_is_admin() and not public.has_production_store_access() then
      raise exception 'Production store or administrator access is required to void a release.';
    end if;
    perform 1 from public.deliveries d where d.id = target_delivery for update;
    perform 1 from public.store_release_logs r
    where r.id = p_id and r.voided_at is null for update;
    if not found then raise exception 'Active release entry not found.'; end if;
    select coalesce(sum(qty), 0) into release_after
    from public.store_release_logs
    where delivery_id = target_delivery and item_key = target_key and voided_at is null and id <> p_id;
    select coalesce(sum(qty), 0) into received
    from public.dispatch_receipt_logs
    where delivery_id = target_delivery and item_key = target_key and voided_at is null;
    if release_after < received then
      raise exception 'This release cannot be voided because it would leave received quantity above released quantity.';
    end if;
    update public.store_release_logs
    set voided_at = now(), voided_by = (select auth.uid()), void_reason = btrim(p_reason)
    where id = p_id;
  elsif p_table = 'dispatch_receipt_logs' then
    select r.delivery_id, r.item_key into target_delivery, target_key
    from public.dispatch_receipt_logs r where r.id = p_id and r.voided_at is null;
    if not found then raise exception 'Active receipt entry not found.'; end if;
    if not public.partial_is_admin() and not public.has_dispatch_access() then
      raise exception 'Dispatch or administrator access is required to void a receipt.';
    end if;
    perform 1 from public.deliveries d where d.id = target_delivery for update;
    perform 1 from public.dispatch_receipt_logs r
    where r.id = p_id and r.voided_at is null for update;
    if not found then raise exception 'Active receipt entry not found.'; end if;
    select coalesce(sum(qty), 0) into received
    from public.dispatch_receipt_logs
    where delivery_id = target_delivery and item_key = target_key and voided_at is null and id <> p_id;
    select coalesce(sum(case
        when t.status = 'Delivered' then ti.qty_delivered
        when t.status in ('Packed', 'Out for delivery') then ti.qty_packed
        else 0         end), 0) into packed
    from public.dispatch_trip_items ti join public.dispatch_trips t on t.id = ti.trip_id
    where ti.delivery_id = target_delivery and ti.item_key = target_key
      and t.voided_at is null and t.status <> 'Failed';
    if received < packed then
      raise exception 'This receipt cannot be voided because it would leave packed quantity above received quantity.';
    end if;
    update public.dispatch_receipt_logs
    set voided_at = now(), voided_by = (select auth.uid()), void_reason = btrim(p_reason)
    where id = p_id;
  elsif p_table = 'dispatch_trips' then
    select t.delivery_id, t.id into target_delivery, trip_id_value
    from public.dispatch_trips t where t.id = p_id and t.voided_at is null;
    if not found then raise exception 'Active trip not found.'; end if;
    if not public.partial_is_admin() and not public.has_dispatch_access() then
      raise exception 'Dispatch or administrator access is required to void a trip.';
    end if;
    perform 1 from public.deliveries d where d.id = target_delivery for update;
    perform 1 from public.dispatch_trips t
    where t.id = p_id and t.voided_at is null for update;
    if not found then raise exception 'Active trip not found.'; end if;
    if exists (select 1 from public.dispatch_trip_items ti where ti.trip_id = trip_id_value and ti.qty_delivered > 0) then
      raise exception 'A trip with delivered quantities cannot be voided.';
    end if;
    update public.dispatch_trips
    set voided_at = now(), voided_by = (select auth.uid()), void_reason = btrim(p_reason)
    where id = p_id;
  else
    raise exception 'Only release logs, receipt logs, and trips can be voided.';
  end if;
end
$function$;

create or replace function public.close_with_balance(p_delivery_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.partial_is_admin() then raise exception 'Administrator access is required.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A close-with-balance reason is required.'; end if;
  update public.deliveries
  set closed_short = true, closed_short_reason = btrim(p_reason)
  where id = p_delivery_id;
  if not found then raise exception 'Delivery not found.'; end if;
end
$function$;

create or replace function public.change_job_card_total(
  p_delivery_id uuid,
  p_item_key text,
  p_new_qty integer
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  old_items jsonb;
  item_found boolean;
begin
  if not public.partial_is_admin() and not public.has_production_store_access() then
    raise exception 'Production store access or administrator access is required to change a job card total.';
  end if;
  if p_new_qty is null or p_new_qty <= 0 then raise exception 'Job card total must be a positive whole number.'; end if;
  select d.items into old_items from public.deliveries d where d.id = p_delivery_id for update;
  if not found then raise exception 'Delivery not found.'; end if;
  select exists (
    select 1 from public.delivery_items_expanded i
    where i.delivery_id = p_delivery_id and i.item_key = p_item_key
  ) into item_found;
  if not item_found then raise exception 'Delivery item not found.'; end if;
  if not public.partial_is_admin() and not exists (
    select 1 from public.deliveries d
    where d.id = p_delivery_id
      and d.created_by is distinct from d.salesperson_id
  ) then
    raise exception 'Production store can change totals only on entries created by the production store.';
  end if;
  if p_new_qty < coalesce((
    select sum(r.qty) from public.store_release_logs r
    where r.delivery_id = p_delivery_id and r.item_key = p_item_key and r.voided_at is null
  ), 0) then
    raise exception 'Job card total cannot be lower than the quantity already released.';
  end if;
  update public.deliveries d
  set items = (
    select pg_catalog.jsonb_agg(
      case when lower(coalesce(nullif(line.item ->> 'item_key', ''),
          public.partial_legacy_item_key(d.id, line.ordinality))) = p_item_key
        then pg_catalog.jsonb_set(line.item, '{quantity}', pg_catalog.to_jsonb(p_new_qty::text), true)
        else line.item end
      order by line.ordinality
    )
    from pg_catalog.jsonb_array_elements(d.items) with ordinality as line(item, ordinality)
  )
  where d.id = p_delivery_id;
end
$function$;

alter table public.store_release_logs enable row level security;
alter table public.dispatch_receipt_logs enable row level security;
alter table public.dispatch_trips enable row level security;
alter table public.dispatch_trip_items enable row level security;
alter table public.item_qty_changes enable row level security;

revoke all on public.store_release_logs, public.dispatch_receipt_logs, public.dispatch_trips,
  public.dispatch_trip_items, public.item_qty_changes from public, anon, authenticated;
grant select on public.store_release_logs, public.dispatch_receipt_logs, public.dispatch_trips,
  public.dispatch_trip_items, public.item_qty_changes to authenticated;

drop policy if exists partial_read_release_logs on public.store_release_logs;
create policy partial_read_release_logs on public.store_release_logs
for select to authenticated using (public.partial_can_read_delivery(delivery_id));
drop policy if exists partial_read_receipt_logs on public.dispatch_receipt_logs;
create policy partial_read_receipt_logs on public.dispatch_receipt_logs
for select to authenticated using (public.partial_can_read_delivery(delivery_id));
drop policy if exists partial_read_trips on public.dispatch_trips;
create policy partial_read_trips on public.dispatch_trips
for select to authenticated using (public.partial_can_read_delivery(delivery_id));
drop policy if exists partial_read_trip_items on public.dispatch_trip_items;
create policy partial_read_trip_items on public.dispatch_trip_items
for select to authenticated using (public.partial_can_read_delivery(delivery_id));
drop policy if exists partial_read_qty_changes on public.item_qty_changes;
create policy partial_read_qty_changes on public.item_qty_changes
for select to authenticated using (public.partial_can_read_delivery(delivery_id));

grant select on public.delivery_items_expanded, public.delivery_item_progress,
  public.delivery_request_progress, public.delivery_partial_constants to authenticated;

revoke all on function public.partial_safe_int(text) from public, anon;
revoke all on function public.partial_legacy_item_key(uuid, bigint) from public, anon;
grant execute on function public.partial_safe_int(text) to authenticated;
grant execute on function public.partial_legacy_item_key(uuid, bigint) to authenticated;
revoke all on function public.partial_is_admin() from public, anon, authenticated;
revoke all on function public.partial_can_read_delivery(uuid) from public, anon;
grant execute on function public.partial_can_read_delivery(uuid) to authenticated;
revoke all on function public.partial_prepare_delivery_items() from public, anon, authenticated;
revoke all on function public.release_item(uuid, text, integer, text) from public, anon;
revoke all on function public.receive_item(uuid, text, integer, text) from public, anon;
revoke all on function public.pack_to_trip(uuid, text, integer, uuid, text, uuid, text) from public, anon;
revoke all on function public.deliver_trip(uuid, date, text, jsonb, text) from public, anon;
revoke all on function public.fail_trip(uuid, text) from public, anon;
revoke all on function public.void_entry(text, uuid, text) from public, anon;
revoke all on function public.close_with_balance(uuid, text) from public, anon;
revoke all on function public.change_job_card_total(uuid, text, integer) from public, anon;
grant execute on function public.release_item(uuid, text, integer, text) to authenticated;
grant execute on function public.receive_item(uuid, text, integer, text) to authenticated;
grant execute on function public.pack_to_trip(uuid, text, integer, uuid, text, uuid, text) to authenticated;
grant execute on function public.deliver_trip(uuid, date, text, jsonb, text) to authenticated;
grant execute on function public.fail_trip(uuid, text) to authenticated;
grant execute on function public.void_entry(text, uuid, text) to authenticated;
grant execute on function public.close_with_balance(uuid, text) to authenticated;
grant execute on function public.change_job_card_total(uuid, text, integer) to authenticated;

commit;
