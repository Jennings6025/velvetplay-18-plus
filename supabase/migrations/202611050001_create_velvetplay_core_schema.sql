create extension if not exists pgcrypto;

create table if not exists public.vp_members (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  name text not null default 'Guest Member',
  minutes_balance integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  member_id uuid references public.vp_members(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.vp_payments (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  member_id uuid references public.vp_members(id) on delete set null,
  phone text not null,
  amount numeric(12,2) not null check (amount > 0),
  minutes integer not null check (minutes > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired')),
  checkout_request_id text unique,
  merchant_request_id text,
  callback_result_code integer,
  result_desc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.vp_ledger (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.vp_members(id) on delete cascade,
  session_id text not null,
  entry_type text not null check (entry_type in ('payment_credit', 'video_usage', 'admin_adjustment')),
  amount numeric(12,2) not null default 0,
  minutes integer not null default 0,
  payment_id uuid references public.vp_payments(id) on delete set null,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.paid_video_views (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  member_id uuid references public.vp_members(id) on delete set null,
  creator_name text not null,
  seconds_used integer not null default 0 check (seconds_used >= 0),
  minutes_used integer not null default 0 check (minutes_used >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_vp_members_session_id on public.vp_members (session_id);
create index if not exists idx_vp_payments_session_id on public.vp_payments (session_id);
create index if not exists idx_vp_payments_member_id on public.vp_payments (member_id);
create index if not exists idx_vp_ledger_member_id on public.vp_ledger (member_id);
create index if not exists idx_vp_ledger_session_id on public.vp_ledger (session_id);
create index if not exists idx_paid_video_views_member_id on public.paid_video_views (member_id);
create index if not exists idx_paid_video_views_session_id on public.paid_video_views (session_id);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_vp_members_touch_updated_at
before update on public.vp_members
for each row execute function public.touch_updated_at();

create trigger trg_vp_payments_touch_updated_at
before update on public.vp_payments
for each row execute function public.touch_updated_at();
