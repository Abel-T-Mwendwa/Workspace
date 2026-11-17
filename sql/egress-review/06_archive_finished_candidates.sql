/*
Purpose: Read-only report of completed deliveries, rider jobs, and artwork
         requests completed before the current month in Africa/Nairobi, plus
         screens and reports that can still read older rows.
Read-only: Yes.
How to run: Run the whole file in Supabase SQL Editor.
How to undo: No database changes are made.

Rows marked finished/done but lacking the completion timestamp are reported
separately because their age cannot be determined reliably. No archive or
delete statements are included for these tables.
*/

-- Current month boundary in Africa/Nairobi, applied consistently to all rows.
WITH cutoff AS (
  SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi')
    AT TIME ZONE 'Africa/Nairobi' AS month_start
)
SELECT 'deliveries' AS table_name,
       count(*) FILTER (
         WHERE delivery.dispatch_status = 'Delivered'
           AND delivery.delivered_at < cutoff.month_start
       ) AS finished_before_month,
       min(delivery.delivered_at) FILTER (
         WHERE delivery.dispatch_status = 'Delivered'
           AND delivery.delivered_at < cutoff.month_start
       ) AS oldest_completion,
       max(delivery.delivered_at) FILTER (
         WHERE delivery.dispatch_status = 'Delivered'
           AND delivery.delivered_at < cutoff.month_start
       ) AS newest_completion,
       count(*) FILTER (
         WHERE delivery.dispatch_status = 'Delivered'
           AND delivery.delivered_at IS NULL
       ) AS finished_missing_timestamp
FROM public.deliveries AS delivery
CROSS JOIN cutoff
UNION ALL
SELECT 'rider_jobs',
       count(*) FILTER (
         WHERE job.status = 'Finished'
           AND job.finished_at < cutoff.month_start
       ),
       min(job.finished_at) FILTER (
         WHERE job.status = 'Finished'
           AND job.finished_at < cutoff.month_start
       ),
       max(job.finished_at) FILTER (
         WHERE job.status = 'Finished'
           AND job.finished_at < cutoff.month_start
       ),
       count(*) FILTER (
         WHERE job.status = 'Finished'
           AND job.finished_at IS NULL
       )
FROM public.rider_jobs AS job
CROSS JOIN cutoff
UNION ALL
SELECT 'artwork_requests',
       count(*) FILTER (
         WHERE request.status = 'Done'
           AND coalesce(request.completed_at, request.done_at) < cutoff.month_start
       ),
       min(coalesce(request.completed_at, request.done_at)) FILTER (
         WHERE request.status = 'Done'
           AND coalesce(request.completed_at, request.done_at) < cutoff.month_start
       ),
       max(coalesce(request.completed_at, request.done_at)) FILTER (
         WHERE request.status = 'Done'
           AND coalesce(request.completed_at, request.done_at) < cutoff.month_start
       ),
       count(*) FILTER (
         WHERE request.status = 'Done'
           AND coalesce(request.completed_at, request.done_at) IS NULL
       )
FROM public.artwork_requests AS request
CROSS JOIN cutoff;

-- Screens/reports that can include older rows; this is a source inventory,
-- not a database-derived screen inventory.
SELECT entity,
       screen_or_report,
       source_location,
       older_row_access
FROM (
  VALUES
    ('deliveries', 'Deliveries / Production store / Dispatch lists',
      'js/app.js:2868, 5066-5155, 5398-5445',
      'Loads the full delivery list; date and status filters are client-side.'),
    ('deliveries', 'Delivery activity counts and report rows',
      'js/app.js:1360-1408, 6318-6328',
      'Period-based counts and on-demand activity rows use created/ready/packed/delivered timestamps.'),
    ('deliveries', 'Status Board and delivery detail/deep links',
      'js/app.js:3993-3995, 5870-5912',
      'Board loads up to 1,000 deliveries; detail can load a row by identifier.'),
    ('rider_jobs', 'Riders / Route admin / My jobs lists and search',
      'js/app.js:6760-6790, 7219-7224, 7422-7427',
      'Lists and search retain historical rows according to current filters and paging.'),
    ('rider_jobs', 'Rider activity and period summaries',
      'js/app.js:7106-7110, 7179-7182, 7328',
      'Period reports use created/assigned/started/finished/declined timestamps.'),
    ('rider_jobs', 'Status Board',
      'js/app.js:4001-4003',
      'Loads rider-job rows without a date cutoff.'),
    ('artwork_requests', 'Sales / Designer / Admin lists and search',
      'js/app.js:1062-1070, 1718-1739, 2106-2110, 2468',
      'Loads all artwork requests for the current page; Admin search/export can include history.'),
    ('artwork_requests', 'Artwork change history',
      'js/app.js:2009-2014',
      'History opens by request ID and includes the request’s change history.'),
    ('artwork_requests', 'Status Board',
      'js/app.js:4000',
      'Loads artwork requests without a date cutoff.')
) AS readers(entity, screen_or_report, source_location, older_row_access)
ORDER BY entity, screen_or_report;
