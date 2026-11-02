begin;

drop policy if exists "hide pending handoffs from delivery operations" on public.deliveries;
create policy "hide pending handoffs from delivery operations" on public.deliveries
as restrictive for select to authenticated using (
  public.current_role()::text not in ('production', 'dispatch')
  or public.current_role()::text = 'production'
  or handoff_status <> 'pending_details'
  or (public.has_production_store_access() and created_by = (select auth.uid()))
);

commit;
