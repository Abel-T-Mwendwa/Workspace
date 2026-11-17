/*
Purpose: List tables in supabase_realtime, show each table's REPLICA IDENTITY,
         flag FULL identity, and identify publication tables not subscribed to
         by the app.
Read-only: Yes.
How to run: Run the whole file in Supabase SQL Editor.
How to undo: No database changes are made.
*/

WITH app_subscribed_tables (table_name, subscription_scope) AS (
  VALUES
    ('deliveries', 'Deliveries pages and Status Board; Home when visible'),
    ('vehicles', 'Deliveries vehicle updates, Vehicles page, and Home'),
    ('rider_jobs', 'Riders, Route admin, My jobs, Status Board, and Home'),
    ('artwork_requests', 'Sales, Designer, Admin, Status Board, and Home'),
    ('artwork_changes', 'Sales and Designer artwork updates'),
    ('artwork_work_notes', 'Sales and Designer work-note updates'),
    ('designer_notifications', 'Designer assignment notifications'),
    ('portal_notifications', 'Recipient-filtered portal notification channel')
)
SELECT publication.pubname,
       publication.schemaname,
       publication.tablename,
       CASE relation.relreplident
         WHEN 'd' THEN 'DEFAULT'
         WHEN 'n' THEN 'NOTHING'
         WHEN 'f' THEN 'FULL'
         WHEN 'i' THEN 'INDEX'
       END AS replica_identity,
       relation.relreplident = 'f' AS replica_identity_full,
       coalesce(app.subscription_scope, 'Never subscribed to by the app')
         AS app_subscription
FROM pg_publication_tables AS publication
JOIN pg_class AS relation
  ON relation.oid = format('%I.%I', publication.schemaname, publication.tablename)::regclass
LEFT JOIN app_subscribed_tables AS app
  ON app.table_name = publication.tablename
WHERE publication.pubname = 'supabase_realtime'
ORDER BY publication.schemaname, publication.tablename;

-- App subscriptions absent from the realtime publication (if any).
WITH app_subscribed_tables (table_name, subscription_scope) AS (
  VALUES
    ('deliveries', 'Deliveries pages and Status Board; Home when visible'),
    ('vehicles', 'Deliveries vehicle updates, Vehicles page, and Home'),
    ('rider_jobs', 'Riders, Route admin, My jobs, Status Board, and Home'),
    ('artwork_requests', 'Sales, Designer, Admin, Status Board, and Home'),
    ('artwork_changes', 'Sales and Designer artwork updates'),
    ('artwork_work_notes', 'Sales and Designer work-note updates'),
    ('designer_notifications', 'Designer assignment notifications'),
    ('portal_notifications', 'Recipient-filtered portal notification channel')
)
SELECT app.table_name,
       app.subscription_scope,
       'Subscribed in app but absent from supabase_realtime' AS finding
FROM app_subscribed_tables AS app
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_publication_tables AS publication
  WHERE publication.pubname = 'supabase_realtime'
    AND publication.schemaname = 'public'
    AND publication.tablename = app.table_name
)
ORDER BY app.table_name;
