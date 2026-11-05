alter table public.vp_members enable row level security;
alter table public.user_sessions enable row level security;
alter table public.vp_payments enable row level security;
alter table public.vp_ledger enable row level security;
alter table public.paid_video_views enable row level security;

create policy if not exists "vp_members_select_own" on public.vp_members
for select using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "vp_members_update_own" on public.vp_members
for update using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
) with check (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "vp_payments_select_own" on public.vp_payments
for select using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "vp_ledger_select_own" on public.vp_ledger
for select using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "paid_video_views_select_own" on public.paid_video_views
for select using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "user_sessions_select_own" on public.user_sessions
for select using (
  session_id = current_setting('request.jwt.claims', true)::json->>'session_id'
  or auth.uid() is not null
);

create policy if not exists "service_role_all_access_vp_members" on public.vp_members
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy if not exists "service_role_all_access_vp_payments" on public.vp_payments
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy if not exists "service_role_all_access_vp_ledger" on public.vp_ledger
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy if not exists "service_role_all_access_user_sessions" on public.user_sessions
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy if not exists "service_role_all_access_paid_video_views" on public.paid_video_views
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
