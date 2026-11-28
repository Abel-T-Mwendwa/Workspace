/*
Purpose: Archive read portal/designer notifications created before the current
         Africa/Nairobi month; preserve unread notifications.
Read-only: No. This creates archive tables and deletes eligible source rows.
How to run: First run only the PREVIEW statements and inspect their results.
            Then run the complete file manually in Supabase SQL Editor; do not
            run it from an automated migration or schedule it. The transaction
            commits at the end. Adjust the single cutoff expression below for
            a rerun.
How to undo: Before COMMIT, issue ROLLBACK. After COMMIT, restore source rows
             from the archive tables with an explicit INSERT; do not delete
             archive rows until restoration is verified.

BEHAVIOR WARNING: The bell displays the latest 50 portal_notifications rows
per recipient without a day filter. Archiving read rows can remove entries
from that list when fewer than 50 newer rows exist. The preview below reports
the current affected recipients and rows that would leave the latest 50.
The exact rows at a tied created_at boundary can vary because the app orders
only by created_at.
*/

BEGIN;

-- Single cutoff variable: start of the current month in Africa/Nairobi.
CREATE TEMP TABLE _notification_archive_config (
  cutoff timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO _notification_archive_config (cutoff)
SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi')
  AT TIME ZONE 'Africa/Nairobi';

-- PREVIEW: eligible counts and created_at range for each source table.
SELECT 'portal_notifications' AS table_name,
       count(*) AS eligible_rows,
       min(created_at) AS min_created_at,
       max(created_at) AS max_created_at
FROM public.portal_notifications, _notification_archive_config
WHERE read_at IS NOT NULL AND created_at < cutoff
UNION ALL
SELECT 'designer_notifications',
       count(*),
       min(created_at),
       max(created_at)
FROM public.designer_notifications, _notification_archive_config
WHERE read_at IS NOT NULL AND created_at < cutoff;

-- PREVIEW: rows in the current portal bell window that would leave it.
WITH ranked AS (
  SELECT n.recipient_id,
         n.id,
         n.created_at,
         n.read_at,
         row_number() OVER (
           PARTITION BY n.recipient_id
           ORDER BY n.created_at DESC, n.id DESC
         ) AS current_position
  FROM public.portal_notifications AS n
)
SELECT recipient_id,
       count(*) AS rows_that_would_leave_latest_50
FROM ranked, _notification_archive_config
WHERE current_position <= 50
  AND read_at IS NOT NULL
  AND created_at < cutoff
GROUP BY recipient_id
ORDER BY recipient_id;

WITH ranked AS (
  SELECT n.recipient_id,
         n.id,
         n.created_at,
         n.read_at,
         row_number() OVER (
           PARTITION BY n.recipient_id
           ORDER BY n.created_at DESC, n.id DESC
         ) AS current_position
  FROM public.portal_notifications AS n
),
affected AS (
  SELECT recipient_id, count(*) AS rows_that_would_leave
  FROM ranked, _notification_archive_config
  WHERE current_position <= 50
    AND read_at IS NOT NULL
    AND created_at < cutoff
  GROUP BY recipient_id
)
SELECT count(*) AS recipients_affected,
       coalesce(sum(rows_that_would_leave), 0) AS rows_leaving_latest_50
FROM affected;

-- PREVIEW: foreign keys touching the source tables and their delete behavior.
SELECT conrelid::regclass AS constraint_table,
       conname AS constraint_name,
       confrelid::regclass AS referenced_table,
       CASE confdeltype
         WHEN 'a' THEN 'NO ACTION'
         WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE'
         WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
       END AS on_delete,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND (
    conrelid IN (
      'public.portal_notifications'::regclass,
      'public.designer_notifications'::regclass
    )
    OR confrelid IN (
      'public.portal_notifications'::regclass,
      'public.designer_notifications'::regclass
    )
  )
ORDER BY constraint_table, constraint_name;

-- PREVIEW: non-internal triggers on either source table.
SELECT t.tgrelid::regclass AS table_name,
       t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid) AS trigger_definition,
       p.oid::regprocedure AS trigger_function
FROM pg_trigger AS t
JOIN pg_proc AS p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND t.tgrelid IN (
    'public.portal_notifications'::regclass,
    'public.designer_notifications'::regclass
  )
ORDER BY table_name, trigger_name;

-- Archive tables copy source columns/defaults but deliberately not source
-- foreign keys. The unique id indexes prevent duplicate archival of an id.
CREATE TABLE IF NOT EXISTS public.portal_notifications_archive (
  LIKE public.portal_notifications
    INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING GENERATED
    INCLUDING STORAGE INCLUDING COMMENTS
);
ALTER TABLE public.portal_notifications_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS portal_notifications_archive_id_uq
  ON public.portal_notifications_archive (id);
ALTER TABLE public.portal_notifications_archive ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.designer_notifications_archive (
  LIKE public.designer_notifications
    INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING GENERATED
    INCLUDING STORAGE INCLUDING COMMENTS
);
ALTER TABLE public.designer_notifications_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS designer_notifications_archive_id_uq
  ON public.designer_notifications_archive (id);
ALTER TABLE public.designer_notifications_archive ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'portal_notifications_archive',
        'designer_notifications_archive'
      )
  ) THEN
    RAISE EXCEPTION 'Archive tables must have no RLS policies before archiving';
  END IF;
END
$$;

-- Lock the eligible source rows against concurrent read_at/created_at changes.
CREATE TEMP TABLE _notification_archive_candidates (
  table_name text NOT NULL,
  id uuid NOT NULL,
  PRIMARY KEY (table_name, id)
) ON COMMIT DROP;

DO $$
BEGIN
  PERFORM source.id
  FROM public.portal_notifications AS source
  CROSS JOIN _notification_archive_config AS config
  WHERE source.read_at IS NOT NULL AND source.created_at < config.cutoff
  FOR UPDATE OF source;

  INSERT INTO _notification_archive_candidates (table_name, id)
  SELECT 'portal_notifications', source.id
  FROM public.portal_notifications AS source
  CROSS JOIN _notification_archive_config AS config
  WHERE source.read_at IS NOT NULL AND source.created_at < config.cutoff;

  PERFORM source.id
  FROM public.designer_notifications AS source
  CROSS JOIN _notification_archive_config AS config
  WHERE source.read_at IS NOT NULL AND source.created_at < config.cutoff
  FOR UPDATE OF source;

  INSERT INTO _notification_archive_candidates (table_name, id)
  SELECT 'designer_notifications', source.id
  FROM public.designer_notifications AS source
  CROSS JOIN _notification_archive_config AS config
  WHERE source.read_at IS NOT NULL AND source.created_at < config.cutoff;
END
$$;

CREATE TEMP TABLE _notification_archive_before ON COMMIT DROP AS
SELECT table_name, count(*) AS before_count
FROM _notification_archive_candidates
GROUP BY table_name;

-- INSERT first, then delete only source rows whose IDs were inserted above.
DO $$
DECLARE
  source_table text;
  archive_table text;
  source_columns text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'portal_notifications',
    'designer_notifications'
  ]
  LOOP
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
    INTO source_columns
    FROM pg_attribute AS a
    WHERE a.attrelid = format('public.%I', source_table)::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped;
    archive_table := source_table || '_archive';

    EXECUTE format(
      'INSERT INTO public.%1$I (%2$s, archived_at)
       SELECT %2$s, now()
       FROM public.%3$I AS source
       JOIN pg_temp._notification_archive_candidates AS candidate
         ON candidate.table_name = %4$L AND candidate.id = source.id',
      archive_table,
      source_columns,
      source_table,
      source_table
    );

    EXECUTE format(
      'DELETE FROM public.%1$I AS source
       USING pg_temp._notification_archive_candidates AS candidate
       WHERE candidate.table_name = %2$L
         AND candidate.id = source.id',
      source_table,
      source_table
    );
  END LOOP;
END
$$;

-- VERIFICATION: before = archived in this run + still-eligible source rows.
SELECT 'portal_notifications' AS table_name,
       before_count,
       (
         SELECT count(*)
         FROM public.portal_notifications_archive AS archived
         JOIN _notification_archive_candidates AS candidate
           ON candidate.table_name = 'portal_notifications'
          AND candidate.id = archived.id
       ) AS archived_this_run,
       (
         SELECT count(*)
         FROM public.portal_notifications AS source, _notification_archive_config
         WHERE source.read_at IS NOT NULL AND source.created_at < cutoff
       ) AS remaining_eligible,
       before_count = (
         SELECT count(*)
         FROM public.portal_notifications_archive AS archived
         JOIN _notification_archive_candidates AS candidate
           ON candidate.table_name = 'portal_notifications'
          AND candidate.id = archived.id
       ) + (
         SELECT count(*)
         FROM public.portal_notifications AS source, _notification_archive_config
         WHERE source.read_at IS NOT NULL AND source.created_at < cutoff
       ) AS before_equals_archived_plus_remaining
FROM _notification_archive_before
WHERE table_name = 'portal_notifications'
UNION ALL
SELECT 'designer_notifications',
       before_count,
       (
         SELECT count(*)
         FROM public.designer_notifications_archive AS archived
         JOIN _notification_archive_candidates AS candidate
           ON candidate.table_name = 'designer_notifications'
          AND candidate.id = archived.id
       ),
       (
         SELECT count(*)
         FROM public.designer_notifications AS source, _notification_archive_config
         WHERE source.read_at IS NOT NULL AND source.created_at < cutoff
       ),
       before_count = (
         SELECT count(*)
         FROM public.designer_notifications_archive AS archived
         JOIN _notification_archive_candidates AS candidate
           ON candidate.table_name = 'designer_notifications'
          AND candidate.id = archived.id
       ) + (
         SELECT count(*)
         FROM public.designer_notifications AS source, _notification_archive_config
         WHERE source.read_at IS NOT NULL AND source.created_at < cutoff
       )
FROM _notification_archive_before
WHERE table_name = 'designer_notifications';

COMMIT;
