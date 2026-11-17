/*
Purpose: Inspect policies and triggers on portal_notifications and
         designer_notifications, and look for cron jobs that could impose a
         server-side day rule, reset, or cleanup.
Read-only: Yes.
How to run: Run the whole file in Supabase SQL Editor.
How to undo: No database changes are made.

The app's portal bell selects the latest 50 rows without a day filter and
uses a separate exact unread count; this review checks for database-side
behavior that could affect that display.
*/

-- RLS policies on both notification tables.
SELECT schemaname,
       tablename,
       policyname,
       permissive,
       roles,
       cmd,
       qual AS using_expression,
       with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('portal_notifications', 'designer_notifications')
ORDER BY tablename, policyname;

-- User-defined triggers and their functions on both notification tables.
SELECT t.tgrelid::regclass AS table_name,
       t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid) AS trigger_definition,
       p.oid::regprocedure AS trigger_function,
       pg_get_functiondef(p.oid) AS function_definition
FROM pg_trigger AS t
JOIN pg_proc AS p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND t.tgrelid IN (
    'public.portal_notifications'::regclass,
    'public.designer_notifications'::regclass
  )
ORDER BY table_name, trigger_name;

-- pg_cron is optional. Dynamic SQL prevents parse-time failure if cron.job
-- does not exist; jobs are returned as NOTICE messages when it is present.
DO $$
DECLARE
  job record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'cron.job is absent; pg_cron is not installed or is not visible';
    RETURN;
  END IF;

  FOR job IN EXECUTE
    'SELECT jobid, schedule, command, active, username, database
       FROM cron.job
      ORDER BY jobid'
  LOOP
    RAISE NOTICE 'cron.job: id=%, schedule=%, active=%, username=%, database=%, command=%',
      job.jobid, job.schedule, job.active, job.username, job.database, job.command;
  END LOOP;
END
$$;
