/*
Purpose: Review indexes for Supabase filters used by notifications, rider jobs,
         and deliveries.
Read-only: No. Each CREATE INDEX statement writes an index to the database.
How to run: Do not run this file as one transaction. Review existing index
            definitions, then run CREATE INDEX CONCURRENTLY statements one at
            a time in Supabase SQL Editor.
How to undo: Run the matching DROP INDEX CONCURRENTLY IF EXISTS statement
             below for each index created by this file.

These indexes can improve database filtering/count performance; they do not
reduce egress by themselves. Existing indexes are noted to help avoid
redundancy. CREATE INDEX IF NOT EXISTS checks the name only, not the definition.
*/

-- portal_notifications: head-only unread count and recipient-scoped latest-50
-- list. Queries: js/portal.js:386-389. Existing
-- portal_notifications_recipient_unread_idx already supports unread counts;
-- compare plans before adding this broader read/unread composite.
CREATE INDEX CONCURRENTLY IF NOT EXISTS portal_notifications_recipient_read_created_idx
  ON public.portal_notifications (recipient_id, read_at, created_at DESC);

-- designer_notifications: recipient/unread notification lookup.
-- Query: js/app.js:2089-2093. Existing designer_notifications_unread_idx is a
-- partial (designer_id, created_at DESC) index for read_at IS NULL; compare
-- plans before adding this broader composite.
CREATE INDEX CONCURRENTLY IF NOT EXISTS designer_notifications_designer_read_created_idx
  ON public.designer_notifications (designer_id, read_at, created_at DESC);

-- Rider route date filtering: js/app.js:6760-6764. The list is ordered and
-- filtered by scheduled_date for Route admin; this index combines assignee
-- with that date. Existing status/created_at indexes are included below.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rider_jobs_assigned_scheduled_date_idx
  ON public.rider_jobs (assigned_rider, scheduled_date);

-- Rider status and active-job filters: js/app.js:6792-6794, 7274-7276.
-- This exact index already exists in migration
-- 20261024000000_deliveries_riders_portal.sql; IF NOT EXISTS avoids recreating
-- it when the migration has been applied.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rider_jobs_status_created_idx
  ON public.rider_jobs (status, created_at DESC);

-- Deliveries status and created-date lookup; existing in migration
-- 20261024000000_deliveries_riders_portal.sql. Delivery list filtering is
-- client-side, but activity counts use status + date predicates
-- (js/app.js:6318-6328).
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_status_created_idx
  ON public.deliveries (production_status, dispatch_status, created_at DESC);

-- Delivery activity count/report date predicates (js/app.js:1360-1384,
-- 6318-6328): created, ready, packed, and delivered timestamps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_ready_at_idx
  ON public.deliveries (ready_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_dispatched_at_idx
  ON public.deliveries (dispatched_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_delivered_at_idx
  ON public.deliveries (delivered_at);

-- created_at is the date predicate for the Received/Pending activity cards.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_created_at_idx
  ON public.deliveries (created_at);

-- Undo only indexes created by this file (also run one at a time).
-- DROP INDEX CONCURRENTLY IF EXISTS public.portal_notifications_recipient_read_created_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.designer_notifications_designer_read_created_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.rider_jobs_assigned_scheduled_date_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.deliveries_ready_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.deliveries_dispatched_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.deliveries_delivered_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS public.deliveries_created_at_idx;
-- Do not drop rider_jobs_status_created_idx or deliveries_status_created_idx
-- as part of undo if they predate this file; both are present in migrations.

-- Later unused-index review:
SELECT schemaname,
       relname AS table_name,
       indexrelname AS index_name,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
