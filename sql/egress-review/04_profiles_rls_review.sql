/*
Purpose: Review RLS policies and public functions that directly reference
         public.profiles, with a qualitative evaluation-frequency note.
Read-only: Yes.
How to run: Run the whole file in Supabase SQL Editor.
How to undo: No database changes are made.

Frequency is a catalog-based estimate, not an EXPLAIN result: policy
expressions are applied to rows subject to RLS, while the planner may hoist
STABLE expressions into an initplan or evaluate them once per statement.
*/

-- Policies on public tables whose predicates mention profiles, plus policies
-- defined on public.profiles itself.
SELECT schemaname,
       tablename,
       policyname,
       permissive,
       roles,
       cmd,
       qual AS using_expression,
       with_check AS check_expression,
       CASE
         WHEN tablename = 'profiles'
           THEN 'RLS policy on profiles; applies to rows read or written'
         ELSE 'RLS predicate mentions profiles; typically evaluated for candidate rows'
       END AS likely_evaluation_frequency
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    tablename = 'profiles'
    OR coalesce(qual, '') ILIKE '%profiles%'
    OR coalesce(with_check, '') ILIKE '%profiles%'
  )
ORDER BY tablename, policyname;

-- Public functions whose definitions directly mention profiles.
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       CASE p.provolatile
         WHEN 'i' THEN 'IMMUTABLE'
         WHEN 's' THEN 'STABLE'
         WHEN 'v' THEN 'VOLATILE'
       END AS volatility,
       p.prosecdef AS security_definer,
       CASE
         WHEN p.provolatile = 'v'
           THEN 'If called in an RLS expression, may be evaluated per row'
         WHEN p.provolatile = 's'
           THEN 'If called in an RLS expression, may be evaluated once per statement'
         ELSE 'Frequency depends on the caller and query plan'
       END AS likely_evaluation_frequency,
       pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND pg_get_functiondef(p.oid) ILIKE '%profiles%'
ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);

/*
Review notes (no policy changes proposed):
- Wrapping auth.uid() as (select auth.uid()) lets PostgreSQL evaluate it as
  an initplan in common RLS plans rather than repeating the call per row.
- A narrowly scoped STABLE SECURITY DEFINER role helper can avoid repeating
  profiles lookups in multiple policy predicates, but must have a fixed
  search_path and least-privilege ownership/grants. Verify definitions and
  EXPLAIN plans before any policy/helper change.
- A function can depend on profiles indirectly through another helper; this
  direct text search does not prove or exclude transitive dependencies.
*/
