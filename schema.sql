--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.12 (Ubuntu 17.12-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_role AS ENUM (
    'salesperson',
    'designer',
    'admin',
    'production',
    'dispatch',
    'route_admin',
    'rider',
    'production_store',
    'user'
);


--
-- Name: artwork_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.artwork_status AS ENUM (
    'Requested',
    'In progress',
    'Change requested',
    'Done'
);


--
-- Name: change_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.change_status AS ENUM (
    'open',
    'done'
);


--
-- Name: admin_delete_delivery(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_delivery(p_delivery_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: admin_delete_user(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_user(p_target_user_id uuid, p_actor_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'auth'
    AS $_$
declare
  actor_role text;
  actor_active boolean;
  target_role text;
  admin_count integer;
  foreign_key record;
  foreign_key_column text;
  has_reference boolean;
  deleted_count integer;
begin
  perform pg_advisory_xact_lock(731019244);

  select role, active into actor_role, actor_active
  from public.profiles
  where id = p_actor_id
  for update;

  if not found or actor_role <> 'admin' or not actor_active then
    raise exception 'Administrator access is required.';
  end if;
  if p_target_user_id is null then
    raise exception 'A user is required.';
  end if;
  if p_target_user_id = p_actor_id then
    raise exception 'You cannot delete your own account.';
  end if;

  select role into target_role
  from public.profiles
  where id = p_target_user_id;
  if not found then
    raise exception 'User not found.';
  end if;
  if target_role = 'admin' then
    select count(*) into admin_count
    from public.profiles
    where role = 'admin';
    if admin_count <= 1 then
      raise exception 'The last remaining administrator cannot be deleted.';
    end if;
  end if;

  for foreign_key in
    select constraint_row.conrelid as relation_oid,
      array_agg(column_row.attname::text order by key_row.ordinality) as columns
    from pg_constraint constraint_row
    cross join lateral unnest(constraint_row.conkey) with ordinality as key_row(attnum, ordinality)
    join pg_attribute column_row
      on column_row.attrelid = constraint_row.conrelid and column_row.attnum = key_row.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.profiles'::regclass
      and constraint_row.conrelid <> 'public.user_credentials'::regclass
    group by constraint_row.conrelid
  loop
    foreach foreign_key_column in array foreign_key.columns
    loop
      execute format(
        'select exists (select 1 from %s where %I = $1)',
        foreign_key.relation_oid::regclass,
        foreign_key_column
      ) into has_reference using p_target_user_id;
      if has_reference then
        raise exception 'This user has linked records and cannot be deleted without removing history.';
      end if;
    end loop;
  end loop;

  delete from auth.users where id = p_target_user_id;
  get diagnostics deleted_count = row_count;
  if deleted_count = 0 then
    raise exception 'Auth user not found.';
  end if;
exception
  when foreign_key_violation then
    raise exception 'This user has linked records and cannot be deleted without removing history.';
end;
$_$;


--
-- Name: admin_view_password(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_view_password(p_target_user_id uuid, p_actor_id uuid, p_key text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_password text;
begin
  if p_key is null or length(p_key) < 32 then
    raise exception 'Credential encryption key is missing or too short';
  end if;
  select extensions.pgp_sym_decrypt(c.encrypted_password, p_key)
    into v_password
    from public.user_credentials c where c.user_id = p_target_user_id;
  if v_password is null then
    raise exception 'No saved password is available; reset the password to store it';
  end if;
  insert into public.audit_log (actor_id, target_user_id, action)
    values (p_actor_id, p_target_user_id, 'password_viewed');
  return v_password;
end
$$;


--
-- Name: after_artwork_change_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.after_artwork_change_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: after_artwork_change_insert_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.after_artwork_change_insert_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform set_config('app.system_change', 'on', true);
  update public.artwork_requests set change_count = change_count + 1 where id = new.artwork_id;
  perform set_config('app.system_change', 'off', true);
  return new;
end
$$;


--
-- Name: after_artwork_change_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.after_artwork_change_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if old.status = 'open'::public.change_status and new.status = 'done'::public.change_status then
    perform set_config('app.system_change', 'on', true);
    update public.artwork_requests
      set changes_done = changes_done + 1,
          updated_at = now()
      where id = new.artwork_id;
    perform set_config('app.system_change', 'off', true);
  end if;
  return new;
end
$$;


--
-- Name: audit_profile_access_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_profile_access_flags() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  actor_id uuid := (select auth.uid());
begin
  if new.production_access is distinct from old.production_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'production_access', 'old', old.production_access, 'new', new.production_access));
  end if;
  if new.dispatch_access is distinct from old.dispatch_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'dispatch_access', 'old', old.dispatch_access, 'new', new.dispatch_access));
  end if;
  if new.production_store_access is distinct from old.production_store_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'production_store_access', 'old', old.production_store_access, 'new', new.production_store_access));
  end if;
  if new.route_admin_access is distinct from old.route_admin_access then
    insert into public.audit_log (actor_id, target_user_id, action, details)
    values (actor_id, new.id, 'profile_access_changed',
      jsonb_build_object('flag', 'route_admin_access', 'old', old.route_admin_access, 'new', new.route_admin_access));
  end if;
  return new;
end;
$$;


--
-- Name: check_so_items(jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_so_items(p_pairs jsonb, p_exclude_id uuid DEFAULT NULL::uuid) RETURNS TABLE(conflict_type text, so text, item_key text, delivery_id uuid, sr text, client_name text, delivery_date date, dispatch_status text, salesperson_name text, reason text, can_view boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: clear_assignment_notification_on_start(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_assignment_notification_on_start() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.status is distinct from old.status
    and new.status in ('In progress'::public.artwork_status, 'Done'::public.artwork_status) then
    update public.designer_notifications
      set read_at = now()
      where artwork_id = new.id and read_at is null;
  end if;
  return new;
end
$$;


--
-- Name: complete_open_artwork_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_open_artwork_changes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if old.status <> 'Done'::public.artwork_status and new.status = 'Done'::public.artwork_status
    and new.done_by is not null then
    update public.artwork_changes
      set status = 'done'::public.change_status, done_at = now(), done_by = new.done_by
      where artwork_id = new.id and status = 'open'::public.change_status;
  end if;
  return new;
end
$$;


--
-- Name: current_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public."current_role"() RETURNS public.app_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select p.role from public.profiles p where p.id = (select auth.uid()) and p.active
$$;


--
-- Name: delivery_client_defaults(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_client_defaults(p_client text) RETURNS TABLE(kind text, value text, contact_number text, uses bigint, last_used timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with matches as (
    select d.contact_name, d.contact_number, d.items, d.created_at
    from public.deliveries d
    where pg_catalog.length(pg_catalog.btrim(coalesce(p_client, ''))) > 0
      and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(d.client_name)), '\s+', ' ', 'g')
        = pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(p_client)), '\s+', ' ', 'g')
  ),
  contacts as (
    select
      'contact'::text as kind,
      pg_catalog.btrim(m.contact_name) as value,
      (pg_catalog.array_agg(pg_catalog.btrim(m.contact_number) order by m.created_at desc)
        filter (where nullif(pg_catalog.btrim(m.contact_number), '') is not null))[1] as contact_number,
      pg_catalog.count(*) as uses,
      pg_catalog.max(m.created_at) as last_used
    from matches m
    where not public.has_production_access()
      and not public.has_dispatch_access()
      and nullif(pg_catalog.btrim(m.contact_name), '') is not null
    group by pg_catalog.btrim(m.contact_name)
  ),
  addresses as (
    select
      'address'::text as kind,
      pg_catalog.btrim(line.item ->> 'address') as value,
      null::text as contact_number,
      pg_catalog.count(*) as uses,
      pg_catalog.max(m.created_at) as last_used
    from matches m
    cross join lateral pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(m.items) = 'array' then m.items else '[]'::jsonb end
    ) as line(item)
    where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
    group by pg_catalog.btrim(line.item ->> 'address')
  )
  (select c.kind, c.value, c.contact_number, c.uses, c.last_used from contacts c order by c.last_used desc limit 5)
  union all
  (select a.kind, a.value, a.contact_number, a.uses, a.last_used from addresses a order by a.last_used desc limit 5)
$$;


--
-- Name: delivery_client_suggestions(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_client_suggestions(p_search text) RETURNS TABLE(client_name text, last_used timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select s.client_name, s.last_used
  from (
    select
      (pg_catalog.array_agg(d.client_name order by d.created_at desc))[1] as client_name,
      pg_catalog.max(d.created_at) as last_used
    from public.deliveries d
    where pg_catalog.length(pg_catalog.btrim(coalesce(p_search, ''))) >= 2
      and nullif(pg_catalog.btrim(d.client_name), '') is not null
      and d.client_name ilike '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
          pg_catalog.btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    group by pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(d.client_name)), '\s+', ' ', 'g')
  ) s
  order by s.last_used desc
  limit 8
$$;


--
-- Name: delivery_goods_status(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_goods_status(value jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
declare
  line_count integer;
  all_ready boolean;
  has_ready boolean;
  has_partial boolean;
  has_not_ready boolean;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array' then
    return null;
  end if;

  select count(*),
    coalesce(bool_and(item ->> 'goods_status' = 'ready'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'ready'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'partial'), false),
    coalesce(bool_or(item ->> 'goods_status' = 'not_ready'), false)
  into line_count, all_ready, has_ready, has_partial, has_not_ready
  from pg_catalog.jsonb_array_elements(value) as lines(item);

  if line_count = 0 or not (has_ready or has_partial or has_not_ready) then
    return null;
  elsif all_ready then
    return 'ready';
  elsif has_partial or has_ready and has_not_ready then
    return 'partial';
  end if;
  return 'not_ready';
end
$$;


--
-- Name: delivery_item_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_item_key(value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: delivery_item_keys_similar(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_item_keys_similar(first_key text, second_key text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
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


--
-- Name: delivery_so_item_pairs(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_so_item_pairs(value jsonb) RETURNS TABLE(so text, item_name text, item_key text)
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
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


--
-- Name: delivery_so_numbers_search_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delivery_so_numbers_search_text(value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
  select coalesce(pg_catalog.string_agg(item ->> 'so_number', ' '), '')
  from pg_catalog.jsonb_array_elements(coalesce(value, '[]'::jsonb)) as lines(item)
$$;


--
-- Name: guard_artwork_branding_and_preference(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_artwork_branding_and_preference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role public.app_role := public.current_role();
begin
  if current_setting('app.system_change', true) = 'on' then
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.branding_details is not distinct from old.branding_details
    and (new.branding_mode is distinct from old.branding_mode
      or new.logo_position is distinct from old.logo_position
      or new.pantone_code is distinct from old.pantone_code
      or new.branding_size is distinct from old.branding_size) then
    raise exception 'Update branding through the branding details field';
  end if;

  if v_role = 'designer' then
    if new.branding_details is distinct from old.branding_details
      or new.preferred_designer is distinct from old.preferred_designer
      or new.preferred_designer_recorded is distinct from old.preferred_designer_recorded then
      raise exception 'Designers cannot change branding details or designer preference';
    end if;
    return new;
  end if;

  if v_role = 'salesperson' then
    if not new.preferred_designer_recorded then
      raise exception 'Choose a designer preference for this request';
    end if;
    if new.preferred_designer is distinct from new.assigned_designer then
      raise exception 'Preferred designer must match the request assignment';
    end if;
    if new.preferred_designer is not null and not exists (
      select 1 from public.profiles p
      where p.id = new.preferred_designer and p.role = 'designer'::public.app_role and p.active
    ) then
      raise exception 'Preferred user must be an active designer';
    end if;
  elsif v_role = 'admin' then
    if new.preferred_designer is distinct from old.preferred_designer
      and new.preferred_designer is not null and not exists (
      select 1 from public.profiles p
      where p.id = new.preferred_designer and p.role = 'designer'::public.app_role and p.active
    ) then
      raise exception 'Preferred user must be an active designer';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: guard_artwork_change_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_artwork_change_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if public.current_role() = 'admin' then
    return new;
  end if;
  if public.current_role() <> 'designer'
    or old.status <> 'open'::public.change_status
    or new.status <> 'done'::public.change_status
    or new.artwork_id is distinct from old.artwork_id
    or new.change_text is distinct from old.change_text
    or new.requested_by is distinct from old.requested_by
    or new.requested_on is distinct from old.requested_on
    or new.created_at is distinct from old.created_at
    or new.done_by is distinct from auth.uid() then
    raise exception 'Only the assigned designer may complete an open change';
  end if;
  if not exists (
    select 1 from public.artwork_requests a
    where a.id = old.artwork_id and a.assigned_designer = auth.uid()
  ) then
    raise exception 'Only the assigned designer may complete this change';
  end if;
  new.done_at := now();
  return new;
end
$$;


--
-- Name: guard_artwork_completed_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_artwork_completed_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if current_setting('app.system_change', true) = 'on' then
    return new;
  end if;
  if new.completed_at is distinct from old.completed_at then
    raise exception 'Completion timestamp is system managed';
  end if;
  return new;
end
$$;


--
-- Name: guard_artwork_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_artwork_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_role public.app_role := public.current_role();
begin
  if current_setting('app.system_change', true) = 'on' then
    return new;
  end if;
  if new.id is distinct from old.id
    or new.sr is distinct from old.sr
    or new.ref_no is distinct from old.ref_no
    or new.created_at is distinct from old.created_at
    or new.created_month is distinct from old.created_month
    or new.created_by is distinct from old.created_by then
    raise exception 'Artwork tracking fields are permanent';
  end if;
  if v_role = 'admin' then
    if new.assigned_designer is distinct from old.assigned_designer then
      if new.assigned_designer is not null and not exists (
        select 1 from public.profiles p
        where p.id = new.assigned_designer and p.role = 'designer'::public.app_role and p.active
      ) then
        raise exception 'Assigned user must be an active designer';
      end if;
      if new.status <> 'Done'::public.artwork_status then
        new.status := 'Requested'::public.artwork_status;
        new.claimed_at := null;
      end if;
    end if;
    return new;
  elsif v_role = 'salesperson' then
    if old.created_by <> auth.uid() or old.status <> 'Requested'::public.artwork_status then
      raise exception 'Salespeople may edit only their own requested artwork';
    end if;
    if new.assigned_designer is not null and not exists (
      select 1 from public.profiles p
      where p.id = new.assigned_designer and p.role = 'designer'::public.app_role and p.active
    ) then
      raise exception 'Assigned user must be an active designer';
    end if;
    if new.date_needed < (now() at time zone 'Africa/Nairobi')::date then
      raise exception 'Date needed cannot be in the past';
    end if;
    if (new.ref_no, new.sr, new.created_at, new.created_month, new.created_by, new.status, new.claimed_at, new.done_at, new.done_by, new.designer_notes, new.change_count, new.changes_done)
      is distinct from
       (old.ref_no, old.sr, old.created_at, old.created_month, old.created_by, old.status, old.claimed_at, old.done_at, old.done_by, old.designer_notes, old.change_count, old.changes_done) then
      raise exception 'Salespeople cannot modify system-managed artwork fields';
    end if;
    return new;
  elsif v_role = 'designer' then
    if new.ref_no is distinct from old.ref_no
      or new.sr is distinct from old.sr
      or new.created_at is distinct from old.created_at
      or new.created_month is distinct from old.created_month
      or new.created_by is distinct from old.created_by
      or new.category is distinct from old.category
      or new.client_name is distinct from old.client_name
      or new.so_number is distinct from old.so_number
      or new.product is distinct from old.product
      or new.branding_mode is distinct from old.branding_mode
      or new.logo_position is distinct from old.logo_position
      or new.pantone_code is distinct from old.pantone_code
      or new.branding_size is distinct from old.branding_size
      or new.high_res_logo is distinct from old.high_res_logo
      or new.redesign_logo is distinct from old.redesign_logo
      or new.additional_info is distinct from old.additional_info
      or new.date_needed is distinct from old.date_needed
      or new.change_count is distinct from old.change_count
      or new.changes_done is distinct from old.changes_done then
      raise exception 'Designers cannot edit request details';
    end if;
    if old.assigned_designer is distinct from auth.uid() then
      if old.assigned_designer is not null
        or new.assigned_designer is distinct from auth.uid()
        or old.status = 'Done'::public.artwork_status
        or new.status <> 'In progress'::public.artwork_status then
        raise exception 'This artwork is not available to claim';
      end if;
      new.claimed_at := now();
    else
      if new.assigned_designer is distinct from old.assigned_designer then
        raise exception 'Designer assignment cannot be changed here';
      end if;
      if new.status not in ('In progress'::public.artwork_status, 'Done'::public.artwork_status) then
        raise exception 'Invalid designer status update';
      end if;
      if new.status = 'Done'::public.artwork_status
        and old.status <> 'In progress'::public.artwork_status then
        raise exception 'Start the artwork before marking it done';
      end if;
      if new.status = 'In progress'::public.artwork_status
        and old.status <> 'In progress'::public.artwork_status then
        new.claimed_at := coalesce(old.claimed_at, now());
      elsif new.claimed_at is distinct from old.claimed_at then
        raise exception 'Claim time is system managed';
      end if;
    end if;
    if new.status = 'Done'::public.artwork_status then
      new.done_at := now();
      new.done_by := auth.uid();
    elsif new.status = 'In progress'::public.artwork_status then
      new.done_at := null;
      new.done_by := null;
    end if;
    return new;
  end if;
  raise exception 'Not authorized to update artwork';
end
$$;


--
-- Name: guard_delivery_so_item_duplicates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_delivery_so_item_duplicates() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: guard_delivery_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_delivery_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  actor_role text := public.current_role()::text;
  prod_change boolean := new.production_status is distinct from old.production_status
    or new.ready_at is distinct from old.ready_at;
  disp_change boolean := new.dispatch_status is distinct from old.dispatch_status
    or new.dispatched_at is distinct from old.dispatched_at
    or new.delivered_at is distinct from old.delivered_at
    or new.delivery_date is distinct from old.delivery_date
    or new.transport is distinct from old.transport
    or new.vehicle_id is distinct from old.vehicle_id;
begin
  if actor_role = 'admin' then
    return new;
  elsif actor_role = 'salesperson'
    and not (public.has_production_access() and prod_change)
    and not (public.has_dispatch_access() and disp_change) then
    if old.salesperson_id is distinct from (select auth.uid())
      or old.handoff_status is null
      or old.handoff_status not in ('pending_details', 'requested')
      or old.dispatch_status = 'Delivered'
      or old.delivered_at is not null
      or new.handoff_status is distinct from 'requested'
      or new.salesperson_id is distinct from old.salesperson_id
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by,
          new.production_status, new.dispatch_status, new.ready_at, new.dispatched_at,
          new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by,
          old.production_status, old.dispatch_status, old.ready_at, old.dispatched_at,
          old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Salespeople may edit assigned requests until delivery';
    end if;
    return new;
  elsif public.has_production_access()
    and (prod_change or (actor_role = 'production' and not disp_change)) then
    if old.salesperson_id = (select auth.uid()) then
      raise exception 'Production cannot mark its assigned salesperson request Ready';
    end if;
    if old.handoff_status is null
      or old.handoff_status not in ('pending_details', 'requested')
      or new.handoff_status is distinct from old.handoff_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.client_name, new.contact_name, new.contact_number, new.items,
          new.delivery_time, new.delivery_time_any, new.delivery_date, new.special_instruction,
          new.dispatch_status, new.dispatched_at, new.delivered_at, new.transport, new.vehicle_id)
       is distinct from
       (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.client_name, old.contact_name, old.contact_number, old.items,
          old.delivery_time, old.delivery_time_any, old.delivery_date, old.special_instruction,
          old.dispatch_status, old.dispatched_at, old.delivered_at, old.transport, old.vehicle_id)
      or old.production_status is distinct from 'Not ready'
      or new.production_status is distinct from 'Ready'
      or old.goods_status is null
      or old.goods_status not in ('ready', 'partial') then
      raise exception 'Production may only mark a goods-ready request Ready once';
    end if;
    new.ready_at := now();
    return new;
  elsif public.has_dispatch_access()
    and (disp_change or (actor_role = 'dispatch' and not prod_change)) then
    if old.handoff_status not in ('pending_details', 'requested')
      or new.handoff_status is distinct from old.handoff_status
      or old.production_status <> 'Ready'
      or new.production_status is distinct from old.production_status
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.handoff_status, new.goods_status, new.goods_status_updated_at, new.client_name,
          new.contact_name, new.contact_number, new.items, new.delivery_time,
          new.delivery_time_any, new.special_instruction, new.ready_at)
         is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.handoff_status, old.goods_status, old.goods_status_updated_at, old.client_name,
          old.contact_name, old.contact_number, old.items, old.delivery_time,
          old.delivery_time_any, old.special_instruction, old.ready_at) then
      raise exception 'Dispatch may update only a production-ready request';
    end if;
    if old.dispatch_status = 'Delivered' then
      raise exception 'Delivered requests cannot be changed';
    end if;
    if old.dispatched_at is null then
      if old.salesperson_id = (select auth.uid()) then
        raise exception 'Dispatch cannot pack its assigned salesperson request';
      end if;
      if new.delivery_date is distinct from old.delivery_date
        or new.dispatch_status is distinct from old.dispatch_status
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id then
        raise exception 'Pack this request before editing its delivery date or transport';
      end if;
      new.dispatched_at := now();
      new.delivered_at := null;
      return new;
    end if;
    new.dispatched_at := old.dispatched_at;
    if new.delivery_date is distinct from old.delivery_date then
      if new.dispatch_status is distinct from old.dispatch_status
        or new.transport is distinct from old.transport
        or new.vehicle_id is distinct from old.vehicle_id then
        raise exception 'Dispatch may only update the delivery date by itself';
      end if;
      return new;
    end if;
    if new.dispatch_status = 'Delivered' then
      if new.transport is null or new.transport not in ('Client', 'Company') then
        raise exception 'Choose Client or Company transport';
      end if;
      if new.transport = 'Company' and not exists (
        select 1 from public.vehicles v where v.id = new.vehicle_id and v.active
      ) then
        raise exception 'Choose an active company vehicle';
      end if;
      if new.transport = 'Client' then new.vehicle_id := null; end if;
      new.delivered_at := now();
    else
      if new.transport is not null and new.transport not in ('Client', 'Company') then
        raise exception 'Choose a transport type';
      end if;
      if new.transport = 'Company' and new.vehicle_id is not null and not exists (
        select 1 from public.vehicles v where v.id = new.vehicle_id and v.active
      ) then
        raise exception 'Choose an active company vehicle';
      end if;
      if new.transport is null and new.vehicle_id is not null then
        raise exception 'Choose a transport type before choosing a vehicle';
      end if;
      if new.transport = 'Client' then new.vehicle_id := null; end if;
      new.delivered_at := null;
    end if;
    return new;
  elsif public.has_production_store_access()
    and (old.created_by = (select auth.uid()) or old.created_by = old.salesperson_id) then
    if new.created_by is distinct from old.created_by
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.salesperson_id,
          new.handoff_status, new.production_status, new.dispatch_status, new.ready_at,
          new.dispatched_at, new.delivered_at, new.transport, new.vehicle_id)
        is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.salesperson_id,
          old.handoff_status, old.production_status, old.dispatch_status, old.ready_at,
          old.dispatched_at, old.delivered_at, old.transport, old.vehicle_id) then
      raise exception 'Production store users may edit only delivery details';
    end if;
    return new;
  end if;
  raise exception 'Not authorized to update delivery requests';
end;
$$;


--
-- Name: guard_profile_access_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_profile_access_flags() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if (
    new.production_access is distinct from old.production_access
    or new.dispatch_access is distinct from old.dispatch_access
    or new.production_store_access is distinct from old.production_store_access
    or new.route_admin_access is distinct from old.route_admin_access
  ) and coalesce(auth.role(), '') <> 'service_role'
    and not public.is_admin() then
    raise exception 'Only administrators may change profile access flags';
  end if;
  return new;
end;
$$;


--
-- Name: guard_rider_job_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_rider_job_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  actor_role text := public.current_role()::text;
begin
  if actor_role = 'admin' then return new; end if;
  if public.has_route_admin_access() and actor_role <> 'rider' then
    if (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.client_name,
        new.contact_name, new.contact_number, new.address, new.job_type, new.details,
        new.expected_time, new.scheduled_date, new.started_at, new.finished_at)
       is distinct from
       (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.client_name,
        old.contact_name, old.contact_number, old.address, old.job_type, old.details,
        old.expected_time, old.scheduled_date, old.started_at, old.finished_at)
      or old.status <> 'Not started' or new.status not in ('Started', 'Declined') then
      raise exception 'Route admin may only assign or decline a pending rider request';
    end if;
    if new.status = 'Declined' then
      if new.assigned_rider is not null or new.rider_time is not null or new.rider_time_end is not null
        or new.assigned_at is not null
        or new.declined_at is not null
        or new.decline_reason is null
        or pg_catalog.length(pg_catalog.btrim(new.decline_reason)) not between 1 and 500 then
        raise exception 'A decline reason between 1 and 500 characters is required';
      end if;
      new.declined_at := now();
      return new;
    end if;
    if new.assigned_rider is null or new.rider_time is null or new.rider_time_end is null
      or new.decline_reason is not null or new.declined_at is not null
      or not exists (
        select 1 from public.profiles p
        where p.id = new.assigned_rider and p.role::text = 'rider' and p.active
      ) then
      raise exception 'Route admin may assign only an unassigned rider request to an active rider and time slot';
    end if;
    new.assigned_at := now();
    return new;
  elsif actor_role = 'rider' then
    if old.assigned_rider <> auth.uid()
      or (new.id, new.sr, new.ref_no, new.created_at, new.created_by, new.client_name,
          new.contact_name, new.contact_number, new.address, new.job_type, new.details,
          new.expected_time, new.scheduled_date, new.assigned_rider, new.rider_time,
          new.rider_time_end, new.assigned_at, new.decline_reason, new.declined_at)
         is distinct from
         (old.id, old.sr, old.ref_no, old.created_at, old.created_by, old.client_name,
          old.contact_name, old.contact_number, old.address, old.job_type, old.details,
          old.expected_time, old.scheduled_date, old.assigned_rider, old.rider_time,
          old.rider_time_end, old.assigned_at, old.decline_reason, old.declined_at) then
      raise exception 'Riders may update only their own assigned job status';
    end if;
    if old.status = 'Started' and new.status = 'In progress' then
      new.started_at := now();
      new.finished_at := null;
    elsif old.status = 'In progress' and new.status = 'Finished' then
      new.finished_at := now();
    else
      raise exception 'Rider jobs must be started before they can be finished';
    end if;
    return new;
  end if;
  raise exception 'Not authorized to update rider jobs';
end
$$;


--
-- Name: has_dispatch_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_dispatch_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and p.role::text <> 'admin'
      and (p.role::text = 'dispatch' or p.dispatch_access)
  )
$$;


--
-- Name: has_nonempty_text_lines(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_nonempty_text_lines(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
  select case
    when value is null or pg_catalog.jsonb_typeof(value) <> 'array' then false
    when pg_catalog.jsonb_array_length(value) = 0 then false
    else not exists (
        select 1
        from pg_catalog.jsonb_array_elements(value) as item(line)
        where pg_catalog.jsonb_typeof(item.line) <> 'string'
          or pg_catalog.length(pg_catalog.btrim(item.line #>> '{}')) = 0
      )
  end
$$;


--
-- Name: has_production_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_production_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and p.role::text <> 'admin'
      and (p.role::text = 'production' or p.production_access)
  )
$$;


--
-- Name: has_production_store_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_production_store_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and (p.role::text = 'production_store' or p.production_store_access)
  )
$$;


--
-- Name: has_route_admin_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_route_admin_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.active
      and (p.role::text in ('admin', 'route_admin') or p.route_admin_access)
  )
$$;


--
-- Name: has_valid_branding_details(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_valid_branding_details(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
declare
  item jsonb;
  field_name text;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array'
    or pg_catalog.jsonb_array_length(value) = 0 then
    return false;
  end if;

  for item in select pg_catalog.jsonb_array_elements(value)
  loop
    if pg_catalog.jsonb_typeof(item) <> 'object' then
      return false;
    end if;
    foreach field_name in array array['logo', 'mode', 'pantone', 'size', 'position']
    loop
      if pg_catalog.jsonb_typeof(item -> field_name) <> 'string' then
        return false;
      end if;
    end loop;
    if pg_catalog.length(pg_catalog.btrim(item ->> 'mode')) = 0 then
      return false;
    end if;
  end loop;
  return true;
end
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(public.current_role() = 'admin'::public.app_role, false)
$$;


--
-- Name: login_attempt_state(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.login_attempt_state(p_username text) RETURNS TABLE(is_locked boolean, locked_until timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  return query
  select coalesce(a.locked_until > now(), false), a.locked_until
  from public.login_attempts a where a.username = lower(trim(p_username));
  if not found then
    return query select false, null::timestamptz;
  end if;
end
$$;


--
-- Name: next_portal_ref(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_portal_ref(p_prefix text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  month_key text := pg_catalog.to_char(now() at time zone 'Africa/Nairobi', 'YYMM');
  next_number integer;
begin
  if p_prefix not in ('DL', 'RJ') then
    raise exception 'Invalid reference prefix';
  end if;
  insert into public.portal_ref_counters (prefix, year_month, last_number)
  values (p_prefix, month_key, 1)
  on conflict (prefix, year_month) do update
    set last_number = public.portal_ref_counters.last_number + 1
  returning last_number into next_number;
  if next_number > 9999 then
    raise exception 'Monthly reference limit reached';
  end if;
  return p_prefix || month_key || pg_catalog.lpad(next_number::text, 4, '0');
end
$$;


--
-- Name: next_ref_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_ref_no() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_month text := to_char(now() at time zone 'Africa/Nairobi', 'YYMM');
  v_sequence integer;
begin
  insert into public.ref_counters (year_month, last_number)
  values (v_month, 1)
  on conflict (year_month) do update
    set last_number = public.ref_counters.last_number + 1
  returning last_number into v_sequence;
  if v_sequence > 9999 then
    raise exception 'Monthly artwork reference limit reached';
  end if;
  return 'PK' || v_month || lpad(v_sequence::text, 4, '0');
end
$$;


--
-- Name: normalize_delivery_so(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_delivery_so(value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: notify_artwork_work_note(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_artwork_work_note() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: notify_delivery_address_levels(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_delivery_address_levels() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  missing_address boolean;
  details_needed boolean;
  urgent boolean;
  old_missing_address boolean := false;
  old_details_needed boolean := false;
  old_urgent boolean := false;
  salesperson_changed boolean := false;
  event_time timestamptz := pg_catalog.clock_timestamp();
  notification_type text;
begin
  missing_address := not exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) as line(item)
    where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
  );
  details_needed := missing_address
    and new.dispatch_status is distinct from 'Delivered'
    and new.delivered_at is null;
  urgent := missing_address
    and new.goods_status = 'ready'
    and new.production_status = 'Ready'
    and new.dispatch_status = 'Not delivered';

  if tg_op = 'UPDATE' then
    old_missing_address := not exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(old.items, '[]'::jsonb)) as line(item)
      where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
    );
    old_details_needed := old_missing_address
      and old.dispatch_status is distinct from 'Delivered'
      and old.delivered_at is null;
    old_urgent := old_missing_address
      and old.goods_status = 'ready'
      and old.production_status = 'Ready'
      and old.dispatch_status = 'Not delivered';
    salesperson_changed := new.salesperson_id is distinct from old.salesperson_id;
  end if;

  if new.salesperson_id is not null then
    if tg_op = 'INSERT' then
      notification_type := case when urgent then 'delivery_address_urgent'
        when details_needed then 'delivery_details_needed' end;
    elsif salesperson_changed then
      notification_type := case when urgent then 'delivery_address_urgent'
        when details_needed then 'delivery_details_needed' end;
    elsif urgent and not old_urgent then
      notification_type := 'delivery_address_urgent';
    elsif details_needed and not old_details_needed then
      notification_type := 'delivery_details_needed';
    end if;

    if notification_type is not null then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(
        new.salesperson_id,
        notification_type,
        new.id,
        notification_type || ':' || new.id || ':' || event_time || ':' || new.salesperson_id
      )
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;


--
-- Name: notify_delivery_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_delivery_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  recipient record;
  event_name text;
  event_time timestamptz;
begin
  if tg_op = 'INSERT' then
    for recipient in
      select p.id from public.profiles p
      where p.active and p.role::text <> 'admin'
        and (p.role::text = 'production' or p.production_access)
    loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, 'delivery_new', new.id, 'delivery_new:' || new.id || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
    return new;
  end if;
  if old.production_status is distinct from new.production_status and new.production_status = 'Ready' then
    event_name := 'delivery_ready';
    event_time := new.ready_at;
    for recipient in
      select p.id from public.profiles p
      where p.active and p.role::text <> 'admin'
        and (p.role::text = 'dispatch' or p.dispatch_access)
    loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, event_name, new.id, event_name || ':' || new.id || ':' || event_time || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
  end if;
  if old.dispatched_at is distinct from new.dispatched_at and new.dispatched_at is not null then
    insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
    values(new.created_by, 'delivery_dispatched', new.id, 'delivery_dispatched:' || new.id || ':' || new.dispatched_at)
    on conflict(event_key) do nothing;
  end if;
  if old.dispatch_status is distinct from new.dispatch_status and new.dispatch_status = 'Delivered' then
    insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
    values(new.created_by, 'delivery_delivered', new.id, 'delivery_delivered:' || new.id || ':' || new.delivered_at)
    on conflict(event_key) do nothing;
  end if;
  return new;
end;
$$;


--
-- Name: notify_delivery_goods_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_delivery_goods_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  should_notify boolean := false;
  missing_address boolean;
  urgent boolean;
begin
  missing_address := not exists (
    select 1
    from pg_catalog.jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) as line(item)
    where nullif(pg_catalog.btrim(line.item ->> 'address'), '') is not null
  );
  urgent := missing_address
    and new.goods_status = 'ready'
    and new.production_status = 'Ready'
    and new.dispatch_status = 'Not delivered';

  if new.handoff_status = 'pending_details' and new.salesperson_id is not null then
    if tg_op = 'INSERT' then
      should_notify := not missing_address;
    else
      should_notify := old.goods_status is distinct from new.goods_status
        and not (missing_address and (urgent or new.salesperson_id is distinct from old.salesperson_id));
    end if;
    if should_notify then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(
        new.salesperson_id,
        'delivery_goods_status',
        new.id,
        'delivery_goods_status:' || new.id || ':' || pg_catalog.clock_timestamp()
      )
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;


--
-- Name: notify_preferred_designer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_preferred_designer() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'UPDATE' and new.preferred_designer is not distinct from old.preferred_designer then
    return new;
  end if;

  update public.designer_notifications
    set read_at = now()
    where artwork_id = new.id and read_at is null;

  if new.preferred_designer is not null then
    insert into public.designer_notifications (artwork_id, designer_id)
    values (new.id, new.preferred_designer);
  end if;
  return new;
end
$$;


--
-- Name: notify_rider_job_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_rider_job_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  recipient record;
begin
  if tg_op = 'INSERT' then
    for recipient in
      select p.id from public.profiles p
      where p.active and (p.role::text in ('admin', 'route_admin') or p.route_admin_access)
    loop
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(recipient.id, 'rider_request_new', new.id, 'rider_request_new:' || new.id || ':' || recipient.id)
      on conflict(event_key) do nothing;
    end loop;
    return new;
  end if;
  if old.status is distinct from new.status then
    if new.status = 'Started' then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(new.assigned_rider, 'rider_job_assigned', new.id,
        'rider_job_assigned:' || new.id || ':' || new.assigned_at || ':' || new.assigned_rider)
      on conflict(event_key) do nothing;
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(new.created_by, 'rider_job_assigned_sales', new.id,
        'rider_job_assigned_sales:' || new.id || ':' || new.assigned_at)
      on conflict(event_key) do nothing;
    elsif new.status = 'In progress' then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(new.created_by, 'rider_job_started', new.id, 'rider_job_started:' || new.id || ':' || new.started_at)
      on conflict(event_key) do nothing;
    elsif new.status = 'Finished' then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(new.created_by, 'rider_job_finished', new.id, 'rider_job_finished:' || new.id || ':' || new.finished_at)
      on conflict(event_key) do nothing;
    elsif new.status = 'Declined' then
      insert into public.portal_notifications(recipient_id, notification_type, related_id, event_key)
      values(new.created_by, 'rider_request_declined', new.id, 'rider_request_declined:' || new.id)
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end
$$;


--
-- Name: prepare_artwork_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_artwork_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.status := 'open'::public.change_status;
  new.done_at := null;
  new.done_by := null;
  new.created_at := now();
  return new;
end
$$;


--
-- Name: prepare_delivery_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_delivery_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  actor_role text := public.current_role()::text;
begin
  if new.handoff_status = 'pending_details' then
    if not public.has_production_store_access() or new.created_by <> (select auth.uid())
      or new.salesperson_id is null or not exists (
        select 1 from public.profiles p
        where p.id = new.salesperson_id and p.role::text = 'salesperson' and p.active
      ) then
      raise exception 'Production store entries require an active assigned salesperson';
    end if;
  elsif actor_role not in ('salesperson', 'admin')
    or (actor_role = 'salesperson' and new.created_by <> (select auth.uid())) then
    raise exception 'Only a salesperson may submit their own delivery request';
  elsif actor_role = 'salesperson' then
    new.salesperson_id := (select auth.uid());
  end if;
  if actor_role not in ('salesperson', 'dispatch')
    and new.handoff_status is distinct from 'pending_details'
    and new.delivery_date is not null
    and new.delivery_date < (now() at time zone 'Africa/Nairobi')::date then
    raise exception 'Delivery date cannot be in the past';
  end if;
  new.id := coalesce(new.id, gen_random_uuid());
  new.created_at := now();
  new.ref_no := public.next_portal_ref('DL');
  new.production_status := 'Not ready';
  new.dispatch_status := 'Not delivered';
  new.ready_at := null;
  new.dispatched_at := null;
  new.delivered_at := null;
  new.transport := null;
  new.vehicle_id := null;
  return new;
end
$$;


--
-- Name: prepare_rider_job_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_rider_job_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  new.scheduled_date := (now() at time zone 'Africa/Nairobi')::date;
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


--
-- Name: record_login_attempt(text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_login_attempt(p_username text, p_success boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_username text := lower(trim(p_username));
begin
  if p_success then
    delete from public.login_attempts where username = v_username;
  else
    insert into public.login_attempts (username, failed_attempts, locked_until, updated_at)
    values (v_username, 1, null, now())
    on conflict (username) do update set
      failed_attempts = case
        when public.login_attempts.locked_until < now() then 1
        else public.login_attempts.failed_attempts + 1
      end,
      locked_until = case
        when public.login_attempts.locked_until < now() then null
        when public.login_attempts.failed_attempts + 1 >= 5 then now() + interval '15 minutes'
        else public.login_attempts.locked_until
      end,
      updated_at = now();
  end if;
end
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_artwork_completion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_artwork_completion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.status = 'Done'::public.artwork_status
    and old.status is distinct from 'Done'::public.artwork_status then
    new.done_at := now();
    new.completed_at := new.done_at;
    new.done_by := coalesce(new.assigned_designer, auth.uid());
  elsif new.status <> 'Done'::public.artwork_status then
    new.done_at := null;
    new.completed_at := null;
    new.done_by := null;
  end if;
  return new;
end
$$;


--
-- Name: set_artwork_ref(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_artwork_ref() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  new.id := gen_random_uuid();
  new.created_at := now();
  new.created_month := to_char(now() at time zone 'Africa/Nairobi', 'YYYY-MM');
  new.ref_no := public.next_ref_no();
  new.status := 'Requested'::public.artwork_status;
  new.claimed_at := null;
  new.done_at := null;
  new.done_by := null;
  new.designer_notes := null;
  new.change_count := 0;
  new.changes_done := 0;
  new.updated_at := now();
  if new.date_needed < (now() at time zone 'Africa/Nairobi')::date then
    raise exception 'Date needed cannot be in the past';
  end if;
  if not new.preferred_designer_recorded
    or new.preferred_designer is distinct from new.assigned_designer then
    raise exception 'Preferred designer must match the request assignment';
  end if;
  if new.assigned_designer is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.assigned_designer and p.role = 'designer'::public.app_role and p.active
  ) then
    raise exception 'Assigned user must be an active designer';
  end if;
  return new;
end
$$;


--
-- Name: set_artwork_work_note_author(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_artwork_work_note_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: set_delivery_goods_status_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_delivery_goods_status_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    new.goods_status_updated_at := case
      when new.goods_status is not null then now()
      else null
    end;
  elsif new.goods_status is distinct from old.goods_status then
    new.goods_status_updated_at := case
      when new.goods_status is not null then now()
      else null
    end;
  end if;
  return new;
end
$$;


--
-- Name: store_user_credential(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.store_user_credential(p_user_id uuid, p_password text, p_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_key is null or length(p_key) < 32 then
    raise exception 'Credential encryption key is missing or too short';
  end if;
  insert into public.user_credentials (user_id, encrypted_password, updated_at)
  values (p_user_id, extensions.pgp_sym_encrypt(p_password, p_key), now())
  on conflict (user_id) do update
    set encrypted_password = excluded.encrypted_password, updated_at = now();
end
$$;


--
-- Name: sync_artwork_branding_legacy_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_artwork_branding_legacy_fields() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  modes jsonb;
  positions jsonb;
begin
  if not public.has_valid_branding_details(new.branding_details) then
    raise exception 'Each branding line must have a mode and valid text fields';
  end if;

  select pg_catalog.jsonb_agg(item -> 'mode' order by ordinal),
         pg_catalog.jsonb_agg(item -> 'position' order by ordinal)
           filter (where pg_catalog.length(pg_catalog.btrim(item ->> 'position')) > 0)
    into modes, positions
    from pg_catalog.jsonb_array_elements(new.branding_details) with ordinality as detail(item, ordinal);

  new.branding_mode := modes;
  new.logo_position := case
    when exists (
      select 1 from pg_catalog.jsonb_array_elements(new.branding_details) as detail(item)
      where pg_catalog.length(pg_catalog.btrim(item ->> 'position')) > 0
    ) then positions
    else null
  end;
  new.pantone_code := nullif(pg_catalog.btrim(new.branding_details -> 0 ->> 'pantone'), '');
  new.branding_size := nullif(pg_catalog.btrim(new.branding_details -> 0 ->> 'size'), '');
  return new;
end
$$;


--
-- Name: sync_delivery_goods_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_delivery_goods_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.goods_status := public.delivery_goods_status(new.items);
  return new;
end
$$;


--
-- Name: touch_artwork(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_artwork() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: valid_delivery_items(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_delivery_items(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
declare
  item jsonb;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array'
    or pg_catalog.jsonb_array_length(value) = 0 then
    return false;
  end if;
  for item in select pg_catalog.jsonb_array_elements(value)
  loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) = 0
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) > 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) = 0
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) > 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'address')), 0) = 0
      or coalesce((item ->> 'quantity')::integer, 0) < 1 then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$$;


--
-- Name: valid_production_delivery_items(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_production_delivery_items(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $_$
declare
  item jsonb;
  quantity_value text;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'array'
    or pg_catalog.jsonb_array_length(value) = 0 then
    return false;
  end if;
  for item in select pg_catalog.jsonb_array_elements(value)
  loop
    quantity_value := nullif(pg_catalog.btrim(item ->> 'quantity'), '');
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'item_name')), 0) not between 1 and 200
      or coalesce(pg_catalog.length(pg_catalog.btrim(item ->> 'so_number')), 0) > 200
      or coalesce(pg_catalog.length(item ->> 'address'), 0) > 200
      or (quantity_value is not null and quantity_value !~ '^[1-9][0-9]{0,4}$')
      or coalesce(item ->> 'goods_status', '') not in ('ready', 'partial', 'not_ready') then
      return false;
    end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end
$_$;


--
-- Name: validate_artwork_detail_lines(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_artwork_detail_lines() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if not public.has_nonempty_text_lines(new.product) then
      raise exception 'Product must contain at least one non-empty line';
    end if;
    if not public.has_nonempty_text_lines(new.branding_mode) then
      raise exception 'Branding must contain at least one valid mode';
    end if;
  else
    if new.product is distinct from old.product and not public.has_nonempty_text_lines(new.product) then
      raise exception 'Product must contain at least one non-empty line';
    end if;
    if new.branding_mode is distinct from old.branding_mode and not public.has_nonempty_text_lines(new.branding_mode) then
      raise exception 'Branding must contain at least one valid mode';
    end if;
  end if;
  return new;
end
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: artwork_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    artwork_id uuid NOT NULL,
    change_text text NOT NULL,
    requested_by text NOT NULL,
    requested_on date DEFAULT ((now() AT TIME ZONE 'Africa/Nairobi'::text))::date NOT NULL,
    status public.change_status DEFAULT 'open'::public.change_status NOT NULL,
    done_at timestamp with time zone,
    done_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artwork_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sr bigint NOT NULL,
    ref_no text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_month text DEFAULT to_char((now() AT TIME ZONE 'Africa/Nairobi'::text), 'YYYY-MM'::text) NOT NULL,
    created_by uuid NOT NULL,
    category text NOT NULL,
    client_name text NOT NULL,
    so_number text NOT NULL,
    product jsonb NOT NULL,
    branding_mode jsonb NOT NULL,
    logo_position jsonb,
    pantone_code text,
    branding_size text,
    high_res_logo boolean DEFAULT false NOT NULL,
    redesign_logo boolean DEFAULT false NOT NULL,
    additional_info text,
    date_needed date NOT NULL,
    assigned_designer uuid,
    status public.artwork_status DEFAULT 'Requested'::public.artwork_status NOT NULL,
    claimed_at timestamp with time zone,
    done_at timestamp with time zone,
    done_by uuid,
    designer_notes text,
    change_count integer DEFAULT 0 NOT NULL,
    changes_done integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    branding_details jsonb NOT NULL,
    preferred_designer uuid,
    preferred_designer_recorded boolean DEFAULT true NOT NULL,
    completed_at timestamp with time zone,
    reference_type text,
    previous_reference text,
    CONSTRAINT artwork_requests_branding_details_check CHECK (public.has_valid_branding_details(branding_details)),
    CONSTRAINT artwork_requests_branding_mode_check CHECK (public.has_nonempty_text_lines(branding_mode)),
    CONSTRAINT artwork_requests_category_check CHECK ((category = ANY (ARRAY['New client'::text, 'Old client'::text]))),
    CONSTRAINT artwork_requests_client_name_check CHECK ((length(btrim(client_name)) > 0)),
    CONSTRAINT artwork_requests_logo_position_check CHECK (((logo_position IS NULL) OR public.has_nonempty_text_lines(logo_position))),
    CONSTRAINT artwork_requests_preferred_designer_recorded_check CHECK ((preferred_designer_recorded OR (preferred_designer IS NULL))),
    CONSTRAINT artwork_requests_product_check CHECK (public.has_nonempty_text_lines(product)),
    CONSTRAINT artwork_requests_reference_type_check CHECK ((reference_type = ANY (ARRAY['new'::text, 'old'::text]))),
    CONSTRAINT artwork_requests_reference_type_consistency CHECK (((reference_type IS NULL) OR (reference_type = 'new'::text) OR ((reference_type = 'old'::text) AND (previous_reference IS NOT NULL) AND (previous_reference <> ''::text)))),
    CONSTRAINT artwork_requests_so_number_check CHECK ((length(btrim(so_number)) > 0)),
    CONSTRAINT ref_no_format CHECK (((ref_no IS NULL) OR (ref_no ~ '^PK[0-9]{8}$'::text)))
);


--
-- Name: artwork_requests_sr_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.artwork_requests ALTER COLUMN sr ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.artwork_requests_sr_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: artwork_work_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artwork_work_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    author_id uuid DEFAULT auth.uid(),
    author_name text NOT NULL,
    author_role text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artwork_work_notes_author_role_check CHECK ((author_role = ANY (ARRAY['designer'::text, 'salesperson'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_id uuid,
    target_user_id uuid,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: branding_sizes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branding_sizes (
    id bigint NOT NULL,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: branding_sizes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.branding_sizes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.branding_sizes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sr bigint NOT NULL,
    ref_no text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    client_name text,
    contact_name text,
    contact_number text,
    items jsonb NOT NULL,
    delivery_time time without time zone,
    delivery_date date,
    special_instruction text,
    production_status text DEFAULT 'Not ready'::text NOT NULL,
    dispatch_status text DEFAULT 'Not delivered'::text NOT NULL,
    ready_at timestamp with time zone,
    dispatched_at timestamp with time zone,
    delivered_at timestamp with time zone,
    transport text,
    vehicle_id uuid,
    salesperson_id uuid,
    handoff_status text DEFAULT 'requested'::text NOT NULL,
    delivery_time_any boolean,
    goods_status text,
    so_numbers_search text GENERATED ALWAYS AS (public.delivery_so_numbers_search_text(items)) STORED,
    goods_status_updated_at timestamp with time zone,
    CONSTRAINT deliveries_client_name_check CHECK (((length(btrim(client_name)) >= 1) AND (length(btrim(client_name)) <= 160))),
    CONSTRAINT deliveries_contact_name_check CHECK (((length(btrim(contact_name)) >= 1) AND (length(btrim(contact_name)) <= 160))),
    CONSTRAINT deliveries_dispatch_status_check CHECK ((dispatch_status = ANY (ARRAY['Not delivered'::text, 'Delivered'::text]))),
    CONSTRAINT deliveries_goods_status_check CHECK ((goods_status = ANY (ARRAY['ready'::text, 'partial'::text, 'not_ready'::text]))),
    CONSTRAINT deliveries_handoff_required_fields_check CHECK (((handoff_status = 'pending_details'::text) OR (production_status = 'Ready'::text) OR ((client_name IS NOT NULL) AND ((length(btrim(client_name)) >= 1) AND (length(btrim(client_name)) <= 160)) AND (delivery_date IS NOT NULL) AND (contact_name IS NOT NULL) AND ((length(btrim(contact_name)) >= 1) AND (length(btrim(contact_name)) <= 160)) AND (contact_number IS NOT NULL) AND (length(btrim(contact_number)) > 0)))),
    CONSTRAINT deliveries_handoff_status_check CHECK ((handoff_status = ANY (ARRAY['pending_details'::text, 'requested'::text]))),
    CONSTRAINT deliveries_items_check CHECK ((((handoff_status = 'pending_details'::text) AND public.valid_production_delivery_items(items)) OR ((handoff_status = 'requested'::text) AND public.valid_delivery_items(items)))),
    CONSTRAINT deliveries_production_status_check CHECK ((production_status = ANY (ARRAY['Not ready'::text, 'Ready'::text]))),
    CONSTRAINT deliveries_ref_no_format CHECK (((ref_no IS NULL) OR (ref_no ~ '^DL[0-9]{8}$'::text))),
    CONSTRAINT deliveries_special_instruction_check CHECK (((special_instruction IS NULL) OR (length(special_instruction) <= 1000))),
    CONSTRAINT deliveries_status_timestamps_check CHECK (((((production_status = 'Not ready'::text) AND (ready_at IS NULL)) OR ((production_status = 'Ready'::text) AND (ready_at IS NOT NULL))) AND (((dispatch_status = 'Not delivered'::text) AND (delivered_at IS NULL)) OR ((dispatch_status = 'Delivered'::text) AND (delivered_at IS NOT NULL) AND (dispatched_at IS NOT NULL) AND (production_status = 'Ready'::text))) AND ((dispatch_status <> 'Delivered'::text) OR (transport IS NOT NULL)) AND ((dispatch_status <> 'Delivered'::text) OR (transport <> 'Company'::text) OR (vehicle_id IS NOT NULL)))),
    CONSTRAINT deliveries_transport_check CHECK (((transport IS NULL) OR (transport = ANY (ARRAY['Client'::text, 'Company'::text]))))
);


--
-- Name: deliveries_role_safe; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.deliveries_role_safe WITH (security_invoker='true') AS
 SELECT id,
    sr,
    ref_no,
    created_at,
    created_by,
    salesperson_id,
    handoff_status,
    goods_status,
    client_name,
        CASE
            WHEN ((public.has_production_access() OR public.has_dispatch_access()) AND (salesperson_id IS DISTINCT FROM ( SELECT auth.uid() AS uid))) THEN NULL::text
            ELSE contact_name
        END AS contact_name,
        CASE
            WHEN ((public.has_production_access() OR public.has_dispatch_access()) AND (salesperson_id IS DISTINCT FROM ( SELECT auth.uid() AS uid))) THEN NULL::text
            ELSE contact_number
        END AS contact_number,
    items,
    delivery_time,
    delivery_time_any,
    delivery_date,
    special_instruction,
    production_status,
    dispatch_status,
    ready_at,
    dispatched_at,
    delivered_at,
    transport,
    vehicle_id,
    so_numbers_search
   FROM public.deliveries;


--
-- Name: deliveries_sr_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.deliveries ALTER COLUMN sr ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.deliveries_sr_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: designer_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.designer_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    artwork_id uuid NOT NULL,
    designer_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    username text NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: portal_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    notification_type text NOT NULL,
    related_id uuid NOT NULL,
    event_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: portal_ref_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_ref_counters (
    prefix text NOT NULL,
    year_month text NOT NULL,
    last_number integer NOT NULL,
    CONSTRAINT portal_ref_counters_last_number_check CHECK (((last_number >= 0) AND (last_number <= 9999))),
    CONSTRAINT portal_ref_counters_prefix_check CHECK ((prefix = ANY (ARRAY['DL'::text, 'RJ'::text]))),
    CONSTRAINT portal_ref_counters_year_month_check CHECK ((year_month ~ '^[0-9]{4}$'::text))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    username text NOT NULL,
    full_name text NOT NULL,
    role public.app_role NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    route_admin_access boolean DEFAULT false NOT NULL,
    password_change_required boolean DEFAULT false NOT NULL,
    production_store_access boolean DEFAULT false NOT NULL,
    rider_request_access boolean DEFAULT false,
    production_access boolean DEFAULT false NOT NULL,
    dispatch_access boolean DEFAULT false NOT NULL
);


--
-- Name: ref_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ref_counters (
    year_month text NOT NULL,
    last_number integer NOT NULL,
    CONSTRAINT ref_counters_last_number_check CHECK (((last_number >= 0) AND (last_number <= 9999))),
    CONSTRAINT ref_counters_year_month_check CHECK ((year_month ~ '^[0-9]{4}$'::text))
);


--
-- Name: rider_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rider_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sr bigint NOT NULL,
    ref_no text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    client_name text NOT NULL,
    contact_name text NOT NULL,
    contact_number text NOT NULL,
    address text NOT NULL,
    job_type text NOT NULL,
    details text NOT NULL,
    expected_time time without time zone,
    scheduled_date date DEFAULT ((now() AT TIME ZONE 'Africa/Nairobi'::text))::date NOT NULL,
    assigned_rider uuid,
    rider_time time without time zone,
    rider_time_end time without time zone,
    status text DEFAULT 'Not started'::text NOT NULL,
    assigned_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    decline_reason text,
    declined_at timestamp with time zone,
    CONSTRAINT rider_jobs_address_check CHECK (((length(btrim(address)) >= 1) AND (length(btrim(address)) <= 240))),
    CONSTRAINT rider_jobs_client_name_check CHECK (((length(btrim(client_name)) >= 1) AND (length(btrim(client_name)) <= 160))),
    CONSTRAINT rider_jobs_contact_name_check CHECK (((length(btrim(contact_name)) >= 1) AND (length(btrim(contact_name)) <= 160))),
    CONSTRAINT rider_jobs_contact_number_length_check CHECK (((length(btrim(contact_number)) >= 1) AND (length(btrim(contact_number)) <= 100))),
    CONSTRAINT rider_jobs_details_check CHECK (((length(btrim(details)) >= 1) AND (length(btrim(details)) <= 500))),
    CONSTRAINT rider_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['Pickup'::text, 'Dropoff'::text]))),
    CONSTRAINT rider_jobs_ref_no_format CHECK (((ref_no IS NULL) OR (ref_no ~ '^RJ[0-9]{8}$'::text))),
    CONSTRAINT rider_jobs_rider_slot_check CHECK ((((assigned_rider IS NULL) AND (rider_time IS NULL) AND (rider_time_end IS NULL)) OR ((assigned_rider IS NOT NULL) AND (rider_time IS NOT NULL) AND (rider_time_end IS NOT NULL) AND (rider_time_end = (rider_time + '01:00:00'::interval))))),
    CONSTRAINT rider_jobs_status_check CHECK ((status = ANY (ARRAY['Not started'::text, 'Started'::text, 'In progress'::text, 'Finished'::text, 'Declined'::text]))),
    CONSTRAINT rider_jobs_status_timestamp_check CHECK ((((status = 'Not started'::text) AND (assigned_rider IS NULL) AND (assigned_at IS NULL) AND (started_at IS NULL) AND (finished_at IS NULL) AND (decline_reason IS NULL) AND (declined_at IS NULL)) OR ((status = 'Started'::text) AND (assigned_rider IS NOT NULL) AND (assigned_at IS NOT NULL) AND (started_at IS NULL) AND (finished_at IS NULL) AND (decline_reason IS NULL) AND (declined_at IS NULL)) OR ((status = 'In progress'::text) AND (assigned_rider IS NOT NULL) AND (assigned_at IS NOT NULL) AND (started_at IS NOT NULL) AND (finished_at IS NULL) AND (decline_reason IS NULL) AND (declined_at IS NULL)) OR ((status = 'Finished'::text) AND (assigned_rider IS NOT NULL) AND (assigned_at IS NOT NULL) AND (started_at IS NOT NULL) AND (finished_at IS NOT NULL) AND (decline_reason IS NULL) AND (declined_at IS NULL)) OR ((status = 'Declined'::text) AND (assigned_rider IS NULL) AND (assigned_at IS NULL) AND (started_at IS NULL) AND (finished_at IS NULL) AND (declined_at IS NOT NULL) AND (decline_reason IS NOT NULL) AND ((length(btrim(decline_reason)) >= 1) AND (length(btrim(decline_reason)) <= 500)))))
);


--
-- Name: rider_jobs_sr_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.rider_jobs ALTER COLUMN sr ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.rider_jobs_sr_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_credentials (
    user_id uuid NOT NULL,
    encrypted_password bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registration_number text NOT NULL,
    description text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT vehicles_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 120))),
    CONSTRAINT vehicles_registration_number_check CHECK (((length(btrim(registration_number)) >= 1) AND (length(btrim(registration_number)) <= 32)))
);


--
-- Name: artwork_changes artwork_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_changes
    ADD CONSTRAINT artwork_changes_pkey PRIMARY KEY (id);


--
-- Name: artwork_requests artwork_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_pkey PRIMARY KEY (id);


--
-- Name: artwork_requests artwork_requests_ref_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_ref_no_key UNIQUE (ref_no);


--
-- Name: artwork_requests artwork_requests_sr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_sr_key UNIQUE (sr);


--
-- Name: artwork_work_notes artwork_work_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_work_notes
    ADD CONSTRAINT artwork_work_notes_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: branding_sizes branding_sizes_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_sizes
    ADD CONSTRAINT branding_sizes_label_key UNIQUE (label);


--
-- Name: branding_sizes branding_sizes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_sizes
    ADD CONSTRAINT branding_sizes_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_ref_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_ref_no_key UNIQUE (ref_no);


--
-- Name: deliveries deliveries_sr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_sr_key UNIQUE (sr);


--
-- Name: designer_notifications designer_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designer_notifications
    ADD CONSTRAINT designer_notifications_pkey PRIMARY KEY (id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (username);


--
-- Name: portal_notifications portal_notifications_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_notifications
    ADD CONSTRAINT portal_notifications_event_key_key UNIQUE (event_key);


--
-- Name: portal_notifications portal_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_notifications
    ADD CONSTRAINT portal_notifications_pkey PRIMARY KEY (id);


--
-- Name: portal_ref_counters portal_ref_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_ref_counters
    ADD CONSTRAINT portal_ref_counters_pkey PRIMARY KEY (prefix, year_month);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_username_key UNIQUE (username);


--
-- Name: ref_counters ref_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ref_counters
    ADD CONSTRAINT ref_counters_pkey PRIMARY KEY (year_month);


--
-- Name: rider_jobs rider_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_jobs
    ADD CONSTRAINT rider_jobs_pkey PRIMARY KEY (id);


--
-- Name: rider_jobs rider_jobs_ref_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_jobs
    ADD CONSTRAINT rider_jobs_ref_no_key UNIQUE (ref_no);


--
-- Name: rider_jobs rider_jobs_sr_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_jobs
    ADD CONSTRAINT rider_jobs_sr_key UNIQUE (sr);


--
-- Name: user_credentials user_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credentials
    ADD CONSTRAINT user_credentials_pkey PRIMARY KEY (user_id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_registration_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_registration_number_key UNIQUE (registration_number);


--
-- Name: artwork_changes_artwork_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artwork_changes_artwork_status_idx ON public.artwork_changes USING btree (artwork_id, status, requested_on DESC);


--
-- Name: artwork_requests_creator_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artwork_requests_creator_created_idx ON public.artwork_requests USING btree (created_by, created_at DESC);


--
-- Name: artwork_requests_designer_needed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artwork_requests_designer_needed_idx ON public.artwork_requests USING btree (assigned_designer, date_needed, status);


--
-- Name: artwork_requests_status_needed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artwork_requests_status_needed_idx ON public.artwork_requests USING btree (status, date_needed);


--
-- Name: artwork_work_notes_request_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artwork_work_notes_request_created_idx ON public.artwork_work_notes USING btree (request_id, created_at);


--
-- Name: audit_log_target_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_target_created_idx ON public.audit_log USING btree (target_user_id, created_at DESC);


--
-- Name: deliveries_client_norm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_client_norm_idx ON public.deliveries USING btree (regexp_replace(lower(btrim(client_name)), '\s+'::text, ' '::text, 'g'::text), created_at DESC);


--
-- Name: deliveries_created_by_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_created_by_created_idx ON public.deliveries USING btree (created_by, created_at DESC);


--
-- Name: deliveries_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_status_created_idx ON public.deliveries USING btree (production_status, dispatch_status, created_at DESC);


--
-- Name: designer_notifications_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX designer_notifications_unread_idx ON public.designer_notifications USING btree (designer_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: portal_notifications_recipient_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portal_notifications_recipient_unread_idx ON public.portal_notifications USING btree (recipient_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: profiles_username_case_insensitive_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_username_case_insensitive_idx ON public.profiles USING btree (lower(username));


--
-- Name: rider_jobs_assignee_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rider_jobs_assignee_status_idx ON public.rider_jobs USING btree (assigned_rider, status, created_at DESC);


--
-- Name: rider_jobs_creator_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rider_jobs_creator_created_idx ON public.rider_jobs USING btree (created_by, created_at DESC);


--
-- Name: rider_jobs_one_in_progress_per_rider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rider_jobs_one_in_progress_per_rider_idx ON public.rider_jobs USING btree (assigned_rider) WHERE ((assigned_rider IS NOT NULL) AND (status = 'In progress'::text));


--
-- Name: rider_jobs_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rider_jobs_status_created_idx ON public.rider_jobs USING btree (status, created_at DESC);


--
-- Name: vehicles_active_registration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vehicles_active_registration_idx ON public.vehicles USING btree (active, registration_number);


--
-- Name: artwork_requests artwork_a_completed_at_guard_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_a_completed_at_guard_before_update BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.guard_artwork_completed_at();


--
-- Name: artwork_requests artwork_assignment_notification_clear_after_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_assignment_notification_clear_after_update AFTER UPDATE OF status ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.clear_assignment_notification_on_start();


--
-- Name: artwork_requests artwork_branding_sync_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_branding_sync_before_insert BEFORE INSERT ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.sync_artwork_branding_legacy_fields();


--
-- Name: artwork_requests artwork_branding_sync_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_branding_sync_before_update BEFORE UPDATE OF branding_details ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.sync_artwork_branding_legacy_fields();


--
-- Name: artwork_requests artwork_branding_update_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_branding_update_guard BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.guard_artwork_branding_and_preference();


--
-- Name: artwork_changes artwork_change_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_change_after_insert AFTER INSERT ON public.artwork_changes FOR EACH ROW EXECUTE FUNCTION public.after_artwork_change_insert();


--
-- Name: artwork_changes artwork_change_after_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_change_after_update AFTER UPDATE ON public.artwork_changes FOR EACH ROW EXECUTE FUNCTION public.after_artwork_change_update();


--
-- Name: artwork_changes artwork_change_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_change_before_insert BEFORE INSERT ON public.artwork_changes FOR EACH ROW EXECUTE FUNCTION public.prepare_artwork_change();


--
-- Name: artwork_changes artwork_change_count_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_change_count_after_insert AFTER INSERT ON public.artwork_changes FOR EACH ROW EXECUTE FUNCTION public.after_artwork_change_insert_count();


--
-- Name: artwork_changes artwork_change_guard_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_change_guard_before_update BEFORE UPDATE ON public.artwork_changes FOR EACH ROW EXECUTE FUNCTION public.guard_artwork_change_update();


--
-- Name: artwork_requests artwork_completion_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_completion_before_update BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.set_artwork_completion();


--
-- Name: artwork_requests artwork_detail_lines_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_detail_lines_before_insert BEFORE INSERT ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.validate_artwork_detail_lines();


--
-- Name: artwork_requests artwork_detail_lines_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_detail_lines_before_update BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.validate_artwork_detail_lines();


--
-- Name: artwork_requests artwork_done_after_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_done_after_update AFTER UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.complete_open_artwork_changes();


--
-- Name: artwork_requests artwork_guard_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_guard_before_update BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.guard_artwork_update();


--
-- Name: artwork_requests artwork_preferred_designer_notification_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_preferred_designer_notification_after_insert AFTER INSERT ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.notify_preferred_designer();


--
-- Name: artwork_requests artwork_preferred_designer_notification_after_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_preferred_designer_notification_after_update AFTER UPDATE OF preferred_designer ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.notify_preferred_designer();


--
-- Name: artwork_requests artwork_ref_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_ref_before_insert BEFORE INSERT ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.set_artwork_ref();


--
-- Name: artwork_requests artwork_touch_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_touch_before_update BEFORE UPDATE ON public.artwork_requests FOR EACH ROW EXECUTE FUNCTION public.touch_artwork();


--
-- Name: artwork_work_notes artwork_work_note_notify_participant; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_work_note_notify_participant AFTER INSERT ON public.artwork_work_notes FOR EACH ROW EXECUTE FUNCTION public.notify_artwork_work_note();


--
-- Name: artwork_work_notes artwork_work_note_set_author; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artwork_work_note_set_author BEFORE INSERT ON public.artwork_work_notes FOR EACH ROW EXECUTE FUNCTION public.set_artwork_work_note_author();


--
-- Name: deliveries deliveries_address_levels_notification_after_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_address_levels_notification_after_change AFTER INSERT OR UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.notify_delivery_address_levels();


--
-- Name: deliveries deliveries_goods_status_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_goods_status_before_insert BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.sync_delivery_goods_status();


--
-- Name: deliveries deliveries_goods_status_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_goods_status_before_update BEFORE UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.sync_delivery_goods_status();


--
-- Name: deliveries deliveries_goods_status_notification_after_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_goods_status_notification_after_change AFTER INSERT OR UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.notify_delivery_goods_status();


--
-- Name: deliveries deliveries_goods_status_timestamp_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_goods_status_timestamp_before_insert BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.set_delivery_goods_status_updated_at();


--
-- Name: deliveries deliveries_goods_status_timestamp_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_goods_status_timestamp_before_update BEFORE UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.set_delivery_goods_status_updated_at();


--
-- Name: deliveries deliveries_guard_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_guard_before_update BEFORE UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_update();


--
-- Name: deliveries deliveries_guard_so_item_duplicates; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_guard_so_item_duplicates BEFORE INSERT OR UPDATE OF items ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_so_item_duplicates();


--
-- Name: deliveries deliveries_notify_after_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_notify_after_change AFTER INSERT OR UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.notify_delivery_events();


--
-- Name: deliveries deliveries_prepare_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER deliveries_prepare_before_insert BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.prepare_delivery_insert();


--
-- Name: profiles profiles_audit_access_flags; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_audit_access_flags AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.audit_profile_access_flags();


--
-- Name: profiles profiles_guard_access_flags; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_guard_access_flags BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.guard_profile_access_flags();


--
-- Name: rider_jobs rider_jobs_guard_before_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rider_jobs_guard_before_update BEFORE UPDATE ON public.rider_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_rider_job_update();


--
-- Name: rider_jobs rider_jobs_notify_after_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rider_jobs_notify_after_change AFTER INSERT OR UPDATE ON public.rider_jobs FOR EACH ROW EXECUTE FUNCTION public.notify_rider_job_events();


--
-- Name: rider_jobs rider_jobs_prepare_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rider_jobs_prepare_before_insert BEFORE INSERT ON public.rider_jobs FOR EACH ROW EXECUTE FUNCTION public.prepare_rider_job_insert();


--
-- Name: artwork_changes artwork_changes_artwork_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_changes
    ADD CONSTRAINT artwork_changes_artwork_id_fkey FOREIGN KEY (artwork_id) REFERENCES public.artwork_requests(id) ON DELETE CASCADE;


--
-- Name: artwork_changes artwork_changes_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_changes
    ADD CONSTRAINT artwork_changes_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.profiles(id);


--
-- Name: artwork_requests artwork_requests_assigned_designer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_assigned_designer_fkey FOREIGN KEY (assigned_designer) REFERENCES public.profiles(id);


--
-- Name: artwork_requests artwork_requests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: artwork_requests artwork_requests_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.profiles(id);


--
-- Name: artwork_requests artwork_requests_preferred_designer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_requests
    ADD CONSTRAINT artwork_requests_preferred_designer_fkey FOREIGN KEY (preferred_designer) REFERENCES public.profiles(id);


--
-- Name: artwork_work_notes artwork_work_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_work_notes
    ADD CONSTRAINT artwork_work_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: artwork_work_notes artwork_work_notes_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artwork_work_notes
    ADD CONSTRAINT artwork_work_notes_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.artwork_requests(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);


--
-- Name: audit_log audit_log_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.profiles(id);


--
-- Name: deliveries deliveries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: deliveries deliveries_salesperson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_salesperson_id_fkey FOREIGN KEY (salesperson_id) REFERENCES public.profiles(id);


--
-- Name: deliveries deliveries_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id);


--
-- Name: designer_notifications designer_notifications_artwork_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designer_notifications
    ADD CONSTRAINT designer_notifications_artwork_id_fkey FOREIGN KEY (artwork_id) REFERENCES public.artwork_requests(id) ON DELETE CASCADE;


--
-- Name: designer_notifications designer_notifications_designer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.designer_notifications
    ADD CONSTRAINT designer_notifications_designer_id_fkey FOREIGN KEY (designer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: portal_notifications portal_notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_notifications
    ADD CONSTRAINT portal_notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: rider_jobs rider_jobs_assigned_rider_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_jobs
    ADD CONSTRAINT rider_jobs_assigned_rider_fkey FOREIGN KEY (assigned_rider) REFERENCES public.profiles(id);


--
-- Name: rider_jobs rider_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_jobs
    ADD CONSTRAINT rider_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: user_credentials user_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credentials
    ADD CONSTRAINT user_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: vehicles vehicles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: artwork_requests Admins delete artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins delete artwork" ON public.artwork_requests FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: branding_sizes Admins insert branding sizes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins insert branding sizes" ON public.branding_sizes FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: artwork_requests Admins manage artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage artwork" ON public.artwork_requests TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: branding_sizes Admins manage branding options; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage branding options" ON public.branding_sizes FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: artwork_changes Admins manage changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage changes" ON public.artwork_changes TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: profiles Admins manage profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage profiles" ON public.profiles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: artwork_work_notes Admins manage work notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage work notes" ON public.artwork_work_notes TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: artwork_requests Admins read all artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read all artwork" ON public.artwork_requests FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: artwork_changes Admins read changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read changes" ON public.artwork_changes FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: branding_sizes Admins update branding sizes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update branding sizes" ON public.branding_sizes FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: profiles Authenticated users can read profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read profiles" ON public.profiles FOR SELECT TO authenticated USING ((active OR public.is_admin() OR (id = ( SELECT auth.uid() AS uid)) OR (public.has_route_admin_access() AND ((role)::text = 'rider'::text))));


--
-- Name: branding_sizes Authenticated users read branding sizes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users read branding sizes" ON public.branding_sizes FOR SELECT TO authenticated USING (true);


--
-- Name: artwork_requests Designers claim or update visible work; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Designers claim or update visible work" ON public.artwork_requests FOR UPDATE TO authenticated USING (((public."current_role"() = 'designer'::public.app_role) AND ((assigned_designer = ( SELECT auth.uid() AS uid)) OR (assigned_designer IS NULL)) AND (status <> 'Done'::public.artwork_status))) WITH CHECK (((public."current_role"() = 'designer'::public.app_role) AND (assigned_designer = ( SELECT auth.uid() AS uid))));


--
-- Name: artwork_changes Designers complete visible changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Designers complete visible changes" ON public.artwork_changes FOR UPDATE TO authenticated USING (((public."current_role"() = 'designer'::public.app_role) AND (status = 'open'::public.change_status) AND (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE ((a.id = artwork_changes.artwork_id) AND (a.assigned_designer = ( SELECT auth.uid() AS uid))))))) WITH CHECK (((status = 'done'::public.change_status) AND (done_by = ( SELECT auth.uid() AS uid))));


--
-- Name: artwork_requests Designers read all artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Designers read all artwork" ON public.artwork_requests FOR SELECT TO authenticated USING ((public."current_role"() = 'designer'::public.app_role));


--
-- Name: designer_notifications Designers read their assignment notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Designers read their assignment notifications" ON public.designer_notifications FOR SELECT TO authenticated USING (((designer_id = ( SELECT auth.uid() AS uid)) AND (public."current_role"() = 'designer'::public.app_role)));


--
-- Name: artwork_changes Designers read visible changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Designers read visible changes" ON public.artwork_changes FOR SELECT TO authenticated USING (((public."current_role"() = 'designer'::public.app_role) AND (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE (a.id = artwork_changes.artwork_id)))));


--
-- Name: artwork_changes Sales add own changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sales add own changes" ON public.artwork_changes FOR INSERT TO authenticated WITH CHECK (((public."current_role"() = 'salesperson'::public.app_role) AND (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE ((a.id = artwork_changes.artwork_id) AND (a.created_by = ( SELECT auth.uid() AS uid))))) AND (status = 'open'::public.change_status)));


--
-- Name: artwork_requests Sales edit own requested artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sales edit own requested artwork" ON public.artwork_requests FOR UPDATE TO authenticated USING (((created_by = ( SELECT auth.uid() AS uid)) AND (public."current_role"() = 'salesperson'::public.app_role) AND (status = 'Requested'::public.artwork_status))) WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (status = 'Requested'::public.artwork_status)));


--
-- Name: artwork_requests Sales insert own artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sales insert own artwork" ON public.artwork_requests FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (public."current_role"() = 'salesperson'::public.app_role) AND (status = 'Requested'::public.artwork_status)));


--
-- Name: artwork_requests Sales read own artwork; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sales read own artwork" ON public.artwork_requests FOR SELECT TO authenticated USING (((created_by = ( SELECT auth.uid() AS uid)) AND (public."current_role"() = 'salesperson'::public.app_role)));


--
-- Name: artwork_changes Sales read own changes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sales read own changes" ON public.artwork_changes FOR SELECT TO authenticated USING (((public."current_role"() = 'salesperson'::public.app_role) AND (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE ((a.id = artwork_changes.artwork_id) AND (a.created_by = ( SELECT auth.uid() AS uid)))))));


--
-- Name: artwork_work_notes Work note participants add notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Work note participants add notes" ON public.artwork_work_notes FOR INSERT TO authenticated WITH CHECK (((author_id = ( SELECT auth.uid() AS uid)) AND (public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE ((a.id = artwork_work_notes.request_id) AND ((((public."current_role"())::text = 'salesperson'::text) AND (artwork_work_notes.author_role = 'salesperson'::text) AND (a.created_by = ( SELECT auth.uid() AS uid))) OR (((public."current_role"())::text = 'designer'::text) AND (artwork_work_notes.author_role = 'designer'::text) AND (a.assigned_designer = ( SELECT auth.uid() AS uid))))))))));


--
-- Name: artwork_work_notes Work note participants read notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Work note participants read notes" ON public.artwork_work_notes FOR SELECT TO authenticated USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.artwork_requests a
  WHERE ((a.id = artwork_work_notes.request_id) AND ((((public."current_role"())::text = 'salesperson'::text) AND (a.created_by = ( SELECT auth.uid() AS uid))) OR (((public."current_role"())::text = 'designer'::text) AND ((a.assigned_designer = ( SELECT auth.uid() AS uid)) OR (a.assigned_designer IS NULL)))))))));


--
-- Name: deliveries admin manage deliveries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin manage deliveries" ON public.deliveries TO authenticated USING (((public."current_role"())::text = 'admin'::text)) WITH CHECK (((public."current_role"())::text = 'admin'::text));


--
-- Name: rider_jobs admin manage rider jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin manage rider jobs" ON public.rider_jobs TO authenticated USING (((public."current_role"())::text = 'admin'::text)) WITH CHECK (((public."current_role"())::text = 'admin'::text));


--
-- Name: artwork_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.artwork_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: artwork_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.artwork_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: artwork_work_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.artwork_work_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: deliveries assigned salesperson complete delivery; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "assigned salesperson complete delivery" ON public.deliveries FOR UPDATE TO authenticated USING ((((public."current_role"())::text = 'salesperson'::text) AND (salesperson_id = ( SELECT auth.uid() AS uid)) AND (handoff_status = ANY (ARRAY['pending_details'::text, 'requested'::text])) AND (dispatch_status IS DISTINCT FROM 'Delivered'::text) AND (delivered_at IS NULL))) WITH CHECK ((((public."current_role"())::text = 'salesperson'::text) AND (salesperson_id = ( SELECT auth.uid() AS uid)) AND (handoff_status = 'requested'::text)));


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: branding_sizes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branding_sizes ENABLE ROW LEVEL SECURITY;

--
-- Name: deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: deliveries delivery role read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "delivery role read" ON public.deliveries FOR SELECT TO authenticated USING ((((public."current_role"())::text = 'admin'::text) OR (((public."current_role"())::text = 'salesperson'::text) AND (created_by = ( SELECT auth.uid() AS uid))) OR public.has_production_access() OR public.has_dispatch_access()));


--
-- Name: designer_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.designer_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicles dispatch manage vehicles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "dispatch manage vehicles" ON public.vehicles TO authenticated USING ((((public."current_role"())::text = 'admin'::text) OR public.has_dispatch_access())) WITH CHECK ((((public."current_role"())::text = 'admin'::text) OR public.has_dispatch_access()));


--
-- Name: vehicles dispatch read vehicles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "dispatch read vehicles" ON public.vehicles FOR SELECT TO authenticated USING ((((public."current_role"())::text = 'admin'::text) OR public.has_dispatch_access() OR public.has_production_access()));


--
-- Name: deliveries dispatch update ready delivery; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "dispatch update ready delivery" ON public.deliveries FOR UPDATE TO authenticated USING ((public.has_dispatch_access() AND (production_status = 'Ready'::text))) WITH CHECK ((public.has_dispatch_access() AND (production_status = 'Ready'::text)));


--
-- Name: deliveries hide pending handoffs from delivery operations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hide pending handoffs from delivery operations" ON public.deliveries AS RESTRICTIVE FOR SELECT TO authenticated USING ((((public."current_role"())::text <> ALL (ARRAY['production'::text, 'dispatch'::text])) OR public.has_production_access() OR public.has_dispatch_access()));


--
-- Name: login_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_ref_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_ref_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: deliveries production mark ready; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "production mark ready" ON public.deliveries FOR UPDATE TO authenticated USING ((public.has_production_access() AND (production_status = 'Not ready'::text))) WITH CHECK ((public.has_production_access() AND (production_status = 'Ready'::text)));


--
-- Name: deliveries production store create assigned delivery; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "production store create assigned delivery" ON public.deliveries FOR INSERT TO authenticated WITH CHECK ((public.has_production_store_access() AND (created_by = ( SELECT auth.uid() AS uid)) AND (handoff_status = 'pending_details'::text) AND (salesperson_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = deliveries.salesperson_id) AND ((p.role)::text = 'salesperson'::text) AND p.active)))));


--
-- Name: deliveries production store edit own deliveries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "production store edit own deliveries" ON public.deliveries FOR UPDATE TO authenticated USING ((public.has_production_store_access() AND ((created_by = ( SELECT auth.uid() AS uid)) OR (created_by = salesperson_id)))) WITH CHECK ((public.has_production_store_access() AND ((created_by = ( SELECT auth.uid() AS uid)) OR (created_by = salesperson_id))));


--
-- Name: deliveries production store read delivery workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "production store read delivery workflow" ON public.deliveries FOR SELECT TO authenticated USING ((public.has_production_store_access() AND ((created_by = ( SELECT auth.uid() AS uid)) OR (handoff_status = 'requested'::text))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: ref_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ref_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: rider_jobs rider jobs visible by role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rider jobs visible by role" ON public.rider_jobs FOR SELECT TO authenticated USING ((((public."current_role"())::text = 'admin'::text) OR (((public."current_role"())::text = 'salesperson'::text) AND (created_by = ( SELECT auth.uid() AS uid))) OR public.has_route_admin_access() OR (((public."current_role"())::text = 'rider'::text) AND (assigned_rider = ( SELECT auth.uid() AS uid)))));


--
-- Name: rider_jobs rider request access create own jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rider request access create own jobs" ON public.rider_jobs FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (((public."current_role"())::text = 'user'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.rider_request_access IS TRUE)))))));


--
-- Name: rider_jobs rider request access read own jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rider request access read own jobs" ON public.rider_jobs FOR SELECT TO authenticated USING (((created_by = ( SELECT auth.uid() AS uid)) AND (((public."current_role"())::text = 'user'::text) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.rider_request_access IS TRUE)))))));


--
-- Name: rider_jobs rider update own assigned job; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rider update own assigned job" ON public.rider_jobs FOR UPDATE TO authenticated USING ((((public."current_role"())::text = 'rider'::text) AND (assigned_rider = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['Started'::text, 'In progress'::text])))) WITH CHECK ((((public."current_role"())::text = 'rider'::text) AND (assigned_rider = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['In progress'::text, 'Finished'::text]))));


--
-- Name: rider_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rider_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: rider_jobs route admin assign rider job; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "route admin assign rider job" ON public.rider_jobs FOR UPDATE TO authenticated USING ((public.has_route_admin_access() AND (status = 'Not started'::text))) WITH CHECK ((public.has_route_admin_access() AND (status = ANY (ARRAY['Started'::text, 'Declined'::text]))));


--
-- Name: deliveries sales create own delivery; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "sales create own delivery" ON public.deliveries FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND ((public."current_role"())::text = 'salesperson'::text)));


--
-- Name: rider_jobs sales create own rider job; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "sales create own rider job" ON public.rider_jobs FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND ((public."current_role"())::text = 'salesperson'::text)));


--
-- Name: deliveries salesperson read assigned deliveries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "salesperson read assigned deliveries" ON public.deliveries FOR SELECT TO authenticated USING ((((public."current_role"())::text = 'salesperson'::text) AND (salesperson_id = ( SELECT auth.uid() AS uid))));


--
-- Name: user_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: portal_notifications users mark own portal notifications read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "users mark own portal notifications read" ON public.portal_notifications FOR UPDATE TO authenticated USING (((recipient_id = ( SELECT auth.uid() AS uid)) AND (read_at IS NULL))) WITH CHECK (((recipient_id = ( SELECT auth.uid() AS uid)) AND (read_at IS NOT NULL)));


--
-- Name: portal_notifications users read own portal notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "users read own portal notifications" ON public.portal_notifications FOR SELECT TO authenticated USING ((recipient_id = ( SELECT auth.uid() AS uid)));


--
-- Name: vehicles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


