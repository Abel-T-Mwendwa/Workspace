begin;

create or replace function public.normalize_delivery_so(value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  normalized text;
  compact text;
  matched text[];
begin
  normalized := pg_catalog.upper(
    pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(value, '')), '[[:space:]]+', ' ', 'g')
  );
  if normalized = '' then
    return '';
  end if;

  compact := pg_catalog.regexp_replace(normalized, '[[:space:]_.-]', '', 'g');
  compact := pg_catalog.regexp_replace(compact, '^SO', '');
  matched := pg_catalog.regexp_match(compact, '^([A-Z]?)([0-9]+)([A-Z]{0,2})$');
  if matched is null then
    return normalized;
  end if;

  return 'SO-' || matched[1] || matched[2]
    || case when matched[3] = '' then '' else '-' || matched[3] end;
end;
$$;

create or replace function public.delivery_item_key(value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  normalized text;
  word text;
  words text[];
  folded text[] := array[]::text[];
begin
  normalized := pg_catalog.lower(pg_catalog.btrim(coalesce(value, '')));
  normalized := pg_catalog.replace(normalized, '&', 'and');
  normalized := pg_catalog.regexp_replace(normalized, '[^a-z0-9 ]', '', 'g');
  normalized := pg_catalog.btrim(pg_catalog.regexp_replace(normalized, '[[:space:]]+', ' ', 'g'));
  if normalized = '' then
    return '';
  end if;

  words := pg_catalog.regexp_split_to_array(normalized, ' ');
  foreach word in array words loop
    if word ~ 'ies$' then
      word := pg_catalog.left(word, pg_catalog.length(word) - 3) || 'y';
    elsif word ~ '(ches|shes|sses|xes|zes)$' then
      word := pg_catalog.left(word, pg_catalog.length(word) - 2);
    elsif word ~ 's$' and word !~ 'ss$' then
      word := pg_catalog.left(word, pg_catalog.length(word) - 1);
    end if;
    folded := pg_catalog.array_append(folded, word);
  end loop;

  return pg_catalog.replace(pg_catalog.array_to_string(folded, ' '), ' ', '');
end;
$$;

create or replace function public.delivery_item_keys_similar(first_key text, second_key text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  first_length integer := pg_catalog.length(first_key);
  second_length integer := pg_catalog.length(second_key);
  max_edits integer;
  previous_row integer[];
  current_row integer[];
  row_number integer;
  column_number integer;
  edit_cost integer;
begin
  if first_key = second_key
    or pg_catalog.strpos(first_key, second_key) > 0
    or pg_catalog.strpos(second_key, first_key) > 0 then
    return true;
  end if;
  if first_length < 5 or second_length < 5 then
    return false;
  end if;

  max_edits := greatest(
    1,
    pg_catalog.floor(greatest(first_length, second_length)::numeric * 0.15)::integer
  );
  if pg_catalog.abs(first_length - second_length) > max_edits then
    return false;
  end if;

  select pg_catalog.array_agg(position order by position)
  into previous_row
  from pg_catalog.generate_series(0, second_length) as positions(position);

  for row_number in 1..first_length loop
    current_row := array[row_number];
    for column_number in 1..second_length loop
      edit_cost := case
        when pg_catalog.substr(first_key, row_number, 1) = pg_catalog.substr(second_key, column_number, 1) then 0
        else 1
      end;
      current_row := pg_catalog.array_append(
        current_row,
        least(
          current_row[column_number] + 1,
          previous_row[column_number + 1] + 1,
          previous_row[column_number] + edit_cost
        )
      );
    end loop;
    previous_row := current_row;
  end loop;

  return previous_row[second_length + 1] <= max_edits;
end;
$$;

create or replace function public.delivery_so_item_pairs(value jsonb)
returns table (so text, item_name text, item_key text)
language sql
immutable
parallel safe
set search_path = ''
as $$
  with item_lines as (
    select line.item, line.ordinality as line_ordinal
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(coalesce(value, '[]'::jsonb)) = 'array'
        then coalesce(value, '[]'::jsonb) else '[]'::jsonb end
    ) with ordinality as line(item, ordinality)
  ),
  item_tokens as (
    select
      item_lines.line_ordinal,
      pg_catalog.btrim(coalesce(item_lines.item ->> 'item_name', '')) as item_name,
      pg_catalog.regexp_split_to_table(
        coalesce(item_lines.item ->> 'so_number', ''), ','
      ) as raw_so
    from item_lines
  ),
  normalized as (
    select
      item_tokens.line_ordinal,
      item_tokens.item_name,
      public.normalize_delivery_so(item_tokens.raw_so) as normalized_so,
      public.delivery_item_key(item_tokens.item_name) as normalized_item_key
    from item_tokens
  )
  select
    normalized.normalized_so,
    normalized.item_name,
    normalized.normalized_item_key
  from normalized
  where normalized.normalized_so <> ''
    and normalized.normalized_item_key <> ''
  group by normalized.line_ordinal, normalized.normalized_so,
    normalized.item_name, normalized.normalized_item_key
$$;

revoke all on function public.normalize_delivery_so(text) from public, anon, authenticated;
revoke all on function public.delivery_item_key(text) from public, anon, authenticated;
revoke all on function public.delivery_item_keys_similar(text, text) from public, anon, authenticated;
revoke all on function public.delivery_so_item_pairs(jsonb) from public, anon, authenticated;

create or replace function public.check_so_items(p_pairs jsonb, p_exclude_id uuid default null)
returns table (
  conflict_type text,
  so text,
  item_key text,
  delivery_id uuid,
  sr text,
  client_name text,
  delivery_date date,
  dispatch_status text,
  salesperson_name text,
  reason text,
  can_view boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with input_pairs as (
    select distinct
      public.normalize_delivery_so(pair.value ->> 'so') as so,
      pg_catalog.btrim(coalesce(pair.value ->> 'item_name', '')) as item_name,
      public.delivery_item_key(pair.value ->> 'item_name') as item_key,
      nullif(pg_catalog.btrim(pair.value ->> 'client_name'), '') as client_name
    from pg_catalog.jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) as pair(value)
  ),
  candidates as (
    select
      'hard'::text as conflict_type,
      input_pairs.so,
      input_pairs.item_key,
      delivery.id as delivery_id,
      delivery.sr::text as sr,
      delivery.client_name,
      delivery.delivery_date,
      delivery.dispatch_status,
      salesperson.full_name as salesperson_name,
      'Already recorded'::text as reason,
      (
        (
          public.current_role()::text = 'admin'
          or (public.current_role()::text = 'salesperson' and delivery.created_by = (select auth.uid()))
          or public.has_production_access()
          or public.has_dispatch_access()
        )
        and (
          (not public.has_production_access() and not public.has_dispatch_access())
          or public.has_production_access()
          or delivery.handoff_status <> 'pending_details'
          or (public.has_production_store_access() and delivery.created_by = (select auth.uid()))
          or (public.has_dispatch_access() and delivery.production_status = 'Ready')
        )
      ) as can_view,
      delivery.created_at
    from input_pairs
    join public.deliveries as delivery on delivery.id is distinct from p_exclude_id
    cross join lateral public.delivery_so_item_pairs(delivery.items) as existing_pair
    left join public.profiles as salesperson
      on salesperson.id = coalesce(delivery.salesperson_id, delivery.created_by)
    where input_pairs.so <> ''
      and input_pairs.item_key <> ''
      and existing_pair.so = input_pairs.so
      and existing_pair.item_key = input_pairs.item_key
      and (
        delivery.so_numbers_search ilike '%' || input_pairs.so || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(input_pairs.so, '[^A-Z0-9]', '', 'g') || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(input_pairs.so, '^SO-', '') || '%'
      )

    union all

    select
      'soft'::text as conflict_type,
      input_pairs.so,
      input_pairs.item_key,
      delivery.id as delivery_id,
      delivery.sr::text as sr,
      delivery.client_name,
      delivery.delivery_date,
      delivery.dispatch_status,
      salesperson.full_name as salesperson_name,
      case
        when delivery.client_name is distinct from input_pairs.client_name
          then 'This SO is already used by a different client'
        else 'A similar item name is already recorded'
      end as reason,
      (
        (
          public.current_role()::text = 'admin'
          or (public.current_role()::text = 'salesperson' and delivery.created_by = (select auth.uid()))
          or public.has_production_access()
          or public.has_dispatch_access()
        )
        and (
          (not public.has_production_access() and not public.has_dispatch_access())
          or public.has_production_access()
          or delivery.handoff_status <> 'pending_details'
          or (public.has_production_store_access() and delivery.created_by = (select auth.uid()))
          or (public.has_dispatch_access() and delivery.production_status = 'Ready')
        )
      ) as can_view,
      delivery.created_at
    from input_pairs
    join public.deliveries as delivery on delivery.id is distinct from p_exclude_id
    cross join lateral public.delivery_so_item_pairs(delivery.items) as existing_pair
    left join public.profiles as salesperson
      on salesperson.id = coalesce(delivery.salesperson_id, delivery.created_by)
    where input_pairs.so <> ''
      and input_pairs.item_key <> ''
      and existing_pair.so = input_pairs.so
      and existing_pair.item_key <> input_pairs.item_key
      and (
        pg_catalog.strpos(input_pairs.item_key, existing_pair.item_key) > 0
        or pg_catalog.strpos(existing_pair.item_key, input_pairs.item_key) > 0
        or public.delivery_item_keys_similar(input_pairs.item_key, existing_pair.item_key)
        or delivery.client_name is distinct from input_pairs.client_name
      )
      and (
        delivery.so_numbers_search ilike '%' || input_pairs.so || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(input_pairs.so, '[^A-Z0-9]', '', 'g') || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(input_pairs.so, '^SO-', '') || '%'
      )
  ),
  ranked as (
    select candidates.*,
      pg_catalog.row_number() over (
        partition by candidates.conflict_type, candidates.so, candidates.item_key, candidates.reason
        order by candidates.created_at desc
      ) as rank_number
    from candidates
  )
  select
    ranked.conflict_type,
    ranked.so,
    ranked.item_key,
    ranked.delivery_id,
    ranked.sr,
    ranked.client_name,
    ranked.delivery_date,
    ranked.dispatch_status,
    case when ranked.can_view then ranked.salesperson_name end,
    ranked.reason,
    ranked.can_view
  from ranked
  where ranked.rank_number = 1
$$;

revoke all on function public.check_so_items(jsonb, uuid) from public, anon;
grant execute on function public.check_so_items(jsonb, uuid) to authenticated;

create or replace function public.guard_delivery_so_item_duplicates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  existing_sr text;
begin
  if tg_op = 'UPDATE' and new.items is not distinct from old.items then
    return new;
  end if;
  if new.items is null or pg_catalog.jsonb_typeof(new.items) <> 'array' then
    return new;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      case when pg_catalog.jsonb_typeof(line.item) = 'object'
        then pg_catalog.jsonb_set(line.item, '{so_number}', pg_catalog.to_jsonb(normalized.value), true)
        else line.item end
      order by line.ordinality
    ),
    '[]'::jsonb
  )
  into new.items
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(coalesce(new.items, '[]'::jsonb)) = 'array'
      then coalesce(new.items, '[]'::jsonb) else '[]'::jsonb end
  ) with ordinality as line(item, ordinality)
  cross join lateral (
    select coalesce(
      pg_catalog.string_agg(tokens.normalized_so, ', ' order by tokens.first_ordinal),
      ''
    ) as value
    from (
      select public.normalize_delivery_so(token.raw_so) as normalized_so,
        min(token.ordinality) as first_ordinal
      from pg_catalog.regexp_split_to_table(
        coalesce(line.item ->> 'so_number', ''), ','
      ) with ordinality as token(raw_so, ordinality)
      where public.normalize_delivery_so(token.raw_so) <> ''
      group by public.normalize_delivery_so(token.raw_so)
    ) as tokens
  ) as normalized;

  for candidate in
    with new_pairs as (
      select pair.so, pair.item_key, pg_catalog.count(*) as pair_count
      from public.delivery_so_item_pairs(new.items) as pair
      group by pair.so, pair.item_key
    ),
    old_pairs as (
      select pair.so, pair.item_key, pg_catalog.count(*) as pair_count
      from public.delivery_so_item_pairs(
        case when tg_op = 'UPDATE' then old.items else '[]'::jsonb end
      ) as pair
      group by pair.so, pair.item_key
    )
    select new_pairs.so, new_pairs.item_key, new_pairs.pair_count as new_count,
      coalesce(old_pairs.pair_count, 0) as old_count
    from new_pairs
    left join old_pairs using (so, item_key)
    where new_pairs.pair_count > coalesce(old_pairs.pair_count, 0)
    order by new_pairs.so, new_pairs.item_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.jsonb_build_array(candidate.so, candidate.item_key)::text, 0
      )
    );

    if candidate.new_count > 1 then
      raise exception 'DUPLICATE_SO_ITEM:%:%:%',
        candidate.so, candidate.item_key, 'SAME_REQUEST';
    end if;

    select delivery.sr::text
    into existing_sr
    from public.deliveries as delivery
    cross join lateral public.delivery_so_item_pairs(delivery.items) as existing_pair
    where delivery.id is distinct from new.id
      and existing_pair.so = candidate.so
      and existing_pair.item_key = candidate.item_key
      and (
        delivery.so_numbers_search ilike '%' || candidate.so || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(candidate.so, '[^A-Z0-9]', '', 'g') || '%'
        or delivery.so_numbers_search ilike '%' || pg_catalog.regexp_replace(candidate.so, '^SO-', '') || '%'
      )
    order by delivery.created_at desc
    limit 1;

    if existing_sr is not null then
      raise exception 'DUPLICATE_SO_ITEM:%:%:%',
        candidate.so, candidate.item_key, existing_sr;
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.guard_delivery_so_item_duplicates() from public, anon, authenticated;

drop trigger if exists deliveries_guard_so_item_duplicates on public.deliveries;
create trigger deliveries_guard_so_item_duplicates
before insert or update of items on public.deliveries
for each row execute function public.guard_delivery_so_item_duplicates();

commit;
