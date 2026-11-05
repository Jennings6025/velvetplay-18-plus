alter table public.vp_members enable row level security;
alter table public.vp_payments enable row level security;
alter table public.vp_ledger enable row level security;
alter table public.vp_video_sessions enable row level security;

drop policy if exists "vp_members_select_own" on public.vp_members;
drop policy if exists "vp_members_update_own" on public.vp_members;
drop policy if exists "vp_payments_select_own" on public.vp_payments;
drop policy if exists "vp_ledger_select_own" on public.vp_ledger;
drop policy if exists "service_role_all_access_vp_members" on public.vp_members;
drop policy if exists "service_role_all_access_vp_payments" on public.vp_payments;
drop policy if exists "service_role_all_access_vp_ledger" on public.vp_ledger;

revoke all on table public.vp_members from anon, authenticated;
revoke all on table public.vp_payments from anon, authenticated;
revoke all on table public.vp_ledger from anon, authenticated;
revoke all on table public.vp_video_sessions from anon, authenticated;
