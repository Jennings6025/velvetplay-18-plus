do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_attribute a
      on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.vp_ledger'::regclass
      and i.indisunique
      and i.indnkeyatts = 1
      and a.attname = 'idempotency_key'
  ) then
    if exists (
      select idempotency_key
      from public.vp_ledger
      where idempotency_key is not null
      group by idempotency_key
      having count(*) > 1
    ) then
      raise exception 'vp_ledger has duplicate idempotency keys; resolve them before adding the unique index';
    end if;

    execute 'create unique index vp_ledger_idempotency_key_uidx on public.vp_ledger (idempotency_key) where idempotency_key is not null';
  end if;
end;
$$;

create table if not exists public.vp_video_sessions (
  id uuid primary key,
  member_id uuid not null references public.vp_members(id) on delete cascade,
  creator_name text not null,
  status text not null check (status in ('playing', 'paused', 'stopped')),
  last_heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vp_video_sessions_member_status_idx
  on public.vp_video_sessions (member_id, status);

create or replace function public.vp_confirm_payment(
  p_checkout_request_id text,
  p_mpesa_receipt text,
  p_result_description text,
  p_callback_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.vp_payments%rowtype;
  v_ledger_id uuid;
  v_balance_seconds integer;
  v_idempotency_key text;
  v_existing_ledger public.vp_ledger%rowtype;
begin
  select * into v_payment
  from public.vp_payments
  where checkout_request_id = p_checkout_request_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_payment.status = 'paid' then
    select balance_seconds into v_balance_seconds
    from public.vp_members where id = v_payment.member_id;
    return jsonb_build_object('status', 'paid', 'payment_id', v_payment.id,
      'balance_seconds', coalesce(v_balance_seconds, 0), 'duplicate', true);
  end if;

  if v_payment.status <> 'pending' or v_payment.seconds_credited is null
      or v_payment.seconds_credited <= 0 or v_payment.member_id is null then
    return jsonb_build_object('status', v_payment.status, 'payment_id', v_payment.id);
  end if;

  v_idempotency_key := 'payment:' || v_payment.id::text;
  insert into public.vp_ledger (
    member_id, payment_id, entry_type, seconds_delta, idempotency_key, metadata
  ) values (
    v_payment.member_id, v_payment.id, 'payment_credit',
    v_payment.seconds_credited, v_idempotency_key,
    jsonb_build_object('amount_kes', v_payment.amount_kes,
      'checkout_request_id', p_checkout_request_id)
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_ledger_id;

  if v_ledger_id is not null then
    update public.vp_members
    set balance_seconds = balance_seconds + v_payment.seconds_credited,
        updated_at = now()
    where id = v_payment.member_id
    returning balance_seconds into v_balance_seconds;

    if not found then
      raise exception 'Payment member does not exist';
    end if;
  else
    select * into v_existing_ledger from public.vp_ledger
    where idempotency_key = v_idempotency_key;
    if not found or v_existing_ledger.member_id is distinct from v_payment.member_id
      or v_existing_ledger.payment_id is distinct from v_payment.id
      or v_existing_ledger.entry_type is distinct from 'payment_credit'
      or v_existing_ledger.seconds_delta is distinct from v_payment.seconds_credited then
      raise exception 'Payment idempotency key conflicts with a different ledger entry';
    end if;
    select balance_seconds into v_balance_seconds
    from public.vp_members where id = v_payment.member_id;
  end if;

  update public.vp_payments
  set status = 'paid',
      mpesa_receipt = coalesce(p_mpesa_receipt, mpesa_receipt),
      result_code = 0,
      result_description = coalesce(p_result_description, 'Payment confirmed'),
      callback_payload = coalesce(p_callback_payload, callback_payload),
      paid_at = coalesce(paid_at, now())
  where id = v_payment.id;

  return jsonb_build_object('status', 'paid', 'payment_id', v_payment.id,
    'balance_seconds', coalesce(v_balance_seconds, 0), 'duplicate', false);
end;
$$;

create or replace function public.vp_fail_payment(
  p_checkout_request_id text,
  p_result_code integer,
  p_result_description text,
  p_callback_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.vp_payments%rowtype;
begin
  select * into v_payment
  from public.vp_payments
  where checkout_request_id = p_checkout_request_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_payment.status = 'pending' then
    update public.vp_payments
    set status = 'failed',
        result_code = p_result_code,
        result_description = p_result_description,
        callback_payload = coalesce(p_callback_payload, callback_payload)
    where id = v_payment.id;
    return jsonb_build_object('status', 'failed', 'payment_id', v_payment.id);
  end if;

  return jsonb_build_object('status', v_payment.status, 'payment_id', v_payment.id);
end;
$$;

create or replace function public.vp_start_video_session(
  p_member_id uuid,
  p_video_session_id uuid,
  p_creator_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance_seconds integer;
begin
  select balance_seconds into v_balance_seconds
  from public.vp_members
  where id = p_member_id and session_expires_at > now();

  if not found or v_balance_seconds <= 0 then
    raise exception 'No active member session or wallet balance';
  end if;

  insert into public.vp_video_sessions (id, member_id, creator_name, status)
  values (p_video_session_id, p_member_id, left(p_creator_name, 80), 'paused');

  return jsonb_build_object('video_session_id', p_video_session_id,
    'status', 'paused', 'balance_seconds', v_balance_seconds);
end;
$$;

create or replace function public.vp_record_video_usage(
  p_member_id uuid,
  p_video_session_id uuid,
  p_seconds integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.vp_video_sessions%rowtype;
  v_ledger_id uuid;
  v_balance_seconds integer;
  v_idempotency_key text;
  v_existing_ledger public.vp_ledger%rowtype;
begin
  if p_seconds is null or p_seconds < 1 or p_seconds > 15
      or p_idempotency_key is null or length(p_idempotency_key) > 80 then
    raise exception 'Invalid video usage event';
  end if;

  select * into v_session
  from public.vp_video_sessions
  where id = p_video_session_id and member_id = p_member_id
  for update;

  if not found or v_session.status <> 'playing' then
    raise exception 'Video session is not playing';
  end if;

  v_idempotency_key := 'video:' || p_member_id::text || ':' || p_idempotency_key;
  insert into public.vp_ledger (
    member_id, payment_id, entry_type, seconds_delta, idempotency_key, metadata
  ) values (
    p_member_id, null, 'video_usage', -p_seconds, v_idempotency_key,
    jsonb_build_object('creator_name', v_session.creator_name,
      'video_session_id', p_video_session_id)
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    select * into v_existing_ledger from public.vp_ledger
    where idempotency_key = v_idempotency_key;
    if not found or v_existing_ledger.member_id is distinct from p_member_id
      or v_existing_ledger.entry_type is distinct from 'video_usage'
      or v_existing_ledger.seconds_delta is distinct from -p_seconds
      or v_existing_ledger.metadata->>'video_session_id' is distinct from p_video_session_id::text then
      raise exception 'Video idempotency key was reused for a different usage event';
    end if;
    select balance_seconds into v_balance_seconds
    from public.vp_members where id = p_member_id;
    return jsonb_build_object('balance_seconds', coalesce(v_balance_seconds, 0),
      'duplicate', true, 'deducted_seconds', 0);
  end if;

  update public.vp_members
  set balance_seconds = balance_seconds - p_seconds, updated_at = now()
  where id = p_member_id and session_expires_at > now()
    and balance_seconds >= p_seconds
  returning balance_seconds into v_balance_seconds;

  if not found then
    raise exception 'Insufficient balance or expired member session';
  end if;

  update public.vp_video_sessions
  set last_heartbeat_at = now(), updated_at = now()
  where id = p_video_session_id;

  return jsonb_build_object('balance_seconds', v_balance_seconds,
    'duplicate', false, 'deducted_seconds', p_seconds);
end;
$$;

create or replace function public.vp_set_video_session_state(
  p_member_id uuid,
  p_video_session_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.vp_video_sessions%rowtype;
  v_balance_seconds integer;
begin
  select * into v_session
  from public.vp_video_sessions
  where id = p_video_session_id and member_id = p_member_id
  for update;

  if not found then
    raise exception 'Video session not found';
  end if;

  if p_action = 'pause' and v_session.status = 'playing' then
    update public.vp_video_sessions set status = 'paused', updated_at = now()
    where id = p_video_session_id;
  elsif p_action = 'resume' and v_session.status = 'paused'
      and exists (select 1 from public.vp_members
        where id = p_member_id and session_expires_at > now()
          and balance_seconds > 0) then
    update public.vp_video_sessions set status = 'playing',
      last_heartbeat_at = now(), updated_at = now()
    where id = p_video_session_id;
  elsif p_action = 'resume' and v_session.status = 'playing' then
    null;
  elsif p_action = 'stop' and v_session.status <> 'stopped' then
    update public.vp_video_sessions set status = 'stopped', updated_at = now()
    where id = p_video_session_id;
  elsif not ((p_action = 'pause' and v_session.status = 'paused')
      or (p_action = 'stop' and v_session.status = 'stopped')) then
    raise exception 'Invalid video session transition';
  end if;

  select balance_seconds into v_balance_seconds
  from public.vp_members where id = p_member_id;

  return jsonb_build_object('status',
    case when p_action = 'resume' then 'playing' else p_action end,
    'balance_seconds', coalesce(v_balance_seconds, 0));
end;
$$;

revoke all on function public.vp_confirm_payment(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.vp_fail_payment(text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.vp_start_video_session(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.vp_record_video_usage(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.vp_set_video_session_state(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.vp_confirm_payment(text, text, text, jsonb) to service_role;
grant execute on function public.vp_fail_payment(text, integer, text, jsonb) to service_role;
grant execute on function public.vp_start_video_session(uuid, uuid, text) to service_role;
grant execute on function public.vp_record_video_usage(uuid, uuid, integer, text) to service_role;
grant execute on function public.vp_set_video_session_state(uuid, uuid, text) to service_role;
