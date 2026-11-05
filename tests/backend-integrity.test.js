const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const supabase = require('../lib/supabase');
const { createSessionHandler } = require('../api/session');
const { createStkHandler } = require('../api/payments/stk');
const { createCallbackHandler } = require('../api/payments/callback');
const { createPaymentStatusHandler } = require('../api/payments/[id].js');
const { createVideoUsageHandler } = require('../api/video/usage');
const { callbackMatchesPayment } = require('../lib/daraja');

const member = { id: 'member-uuid', balance_seconds: 900, session_expires_at: '2099-01-01T00:00:00.000Z' };
const payment = {
  id: 'payment-uuid',
  member_id: member.id,
  amount_kes: 100,
  minutes: 35,
  seconds_credited: 2100,
  phone_number: '254712345678',
  status: 'pending',
  checkout_request_id: 'ws_CO_123'
};

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

function callbackRequest(overrides = {}) {
  return {
    method: 'POST',
    body: {
      Body: {
        stkCallback: {
          CheckoutRequestID: payment.checkout_request_id,
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'QAZ123XYZ' },
              { Name: 'PhoneNumber', Value: 254712345678 }
            ]
          },
          ...overrides
        }
      }
    }
  };
}

test('session lookup uses only a hash of the opaque token and checks expiry', async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const calls = [];
  const query = {
    from(table) { calls.push(['from', table]); return this; },
    select(columns) { calls.push(['select', columns]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    gt(column, value) { calls.push(['gt', column, value]); return this; },
    async maybeSingle() { return { data: member, error: null }; }
  };

  assert.equal(await supabase.getMemberBySessionToken(token, query), member);
  assert.deepEqual(calls[0], ['from', 'vp_members']);
  assert.match(calls.find(([kind]) => kind === 'eq')[2], /^[a-f0-9]{64}$/);
  assert.notEqual(calls.find(([kind]) => kind === 'eq')[2], token);
  assert.equal(calls.find(([kind]) => kind === 'gt')[1], 'session_expires_at');
  assert.doesNotMatch(calls.find(([kind]) => kind === 'select')[1], /session_token_hash/);
  assert.equal(await supabase.getMemberBySessionToken('too-short-token', query), null);
});

test('member creation persists only the hashed token and verified wallet fields', async () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = '2099-01-01T00:00:00.000Z';
  let inserted;
  const client = {
    from(table) { assert.equal(table, 'vp_members'); return this; },
    insert(row) { inserted = row; return this; },
    select(columns) { assert.match(columns, /balance_seconds/); return this; },
    async single() { return { data: { id: member.id, ...inserted }, error: null }; }
  };

  await supabase.createMemberSession(token, expiresAt, client);
  assert.deepEqual(inserted, {
    session_token_hash: supabase.hashSessionToken(token),
    session_expires_at: expiresAt,
    balance_seconds: 0
  });
  assert.equal(Object.values(inserted).includes(token), false);
});

test('wallet changes are routed only through atomic database RPCs', async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { status: 'ok' }, error: null };
    }
  };

  await supabase.confirmPayment(payment.checkout_request_id, 'QAZ123XYZ', 'confirmed', null, client);
  await supabase.failPayment(payment.checkout_request_id, 1032, 'cancelled', null, client);
  await supabase.startVideoSession(member.id, crypto.randomUUID(), 'Emmah', client);
  await supabase.recordVideoUsage(member.id, crypto.randomUUID(), 8, crypto.randomUUID(), client);
  await supabase.setVideoSessionState(member.id, crypto.randomUUID(), 'pause', client);

  assert.deepEqual(calls.map(({ name }) => name), [
    'vp_confirm_payment',
    'vp_fail_payment',
    'vp_start_video_session',
    'vp_record_video_usage',
    'vp_set_video_session_state'
  ]);
  assert.equal(calls[0].args.p_checkout_request_id, payment.checkout_request_id);
  assert.equal(calls[3].args.p_seconds, 8);
  assert.equal(calls[3].args.p_idempotency_key.length, 36);
});

test('new guest sessions store a token hash and never return the raw token', async () => {
  const inserted = [];
  const token = crypto.randomBytes(32).toString('base64url');
  const db = {
    getMemberBySessionToken: async () => null,
    createMemberSession: async (rawToken, expiresAt) => {
      inserted.push({ rawToken, expiresAt, tokenHash: supabase.hashSessionToken(rawToken) });
      return { id: member.id, balance_seconds: 0 };
    }
  };
  const handler = createSessionHandler({ db });
  const res = makeResponse();
  await handler({ method: 'POST', cookies: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /^vp_session=[A-Za-z0-9_-]+; .*HttpOnly/);
  assert.equal(res.body.session_id, undefined);
  assert.equal(res.body.session_token, undefined);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].rawToken, res.headers['Set-Cookie'].split('=')[1].split(';')[0]);
  assert.equal(inserted[0].tokenHash.length, 64);
  assert.ok(Date.parse(inserted[0].expiresAt) > Date.now());
});

test('payment package creation uses verified database columns and server-owned price mapping', async () => {
  const previous = Object.fromEntries(['MPESA_ENVIRONMENT', 'MPESA_TILL_NUMBER', 'MPESA_SHORTCODE', 'MPESA_CALLBACK_URL', 'MPESA_PASSKEY'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    MPESA_ENVIRONMENT: 'sandbox',
    MPESA_TILL_NUMBER: '123456',
    MPESA_CALLBACK_URL: 'https://example.test/api/payments/callback',
    MPESA_PASSKEY: 'test-passkey'
  });
  const inserted = [];
  let stkCalls = 0;
  const db = {
    getMemberBySessionToken: async () => member,
    createPayment: async (row) => inserted.push(row),
    attachCheckoutRequest: async () => {},
    markPaymentRequestFailed: async () => {}
  };
  const handler = createStkHandler({
    db,
    tokenProvider: async () => 'test-token',
    fetchImpl: async () => {
      stkCalls += 1;
      return { ok: true, json: async () => ({ CheckoutRequestID: payment.checkout_request_id, MerchantRequestID: 'merchant-1' }) };
    }
  });

  try {
    const res = makeResponse();
    await handler({ method: 'POST', cookies: { vp_session: 'opaque-session-token' }, body: { phone: '0712345678', amount: 100, minutes: 35 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(stkCalls, 1);
    assert.equal(inserted.length, 1);
    assert.deepEqual(Object.keys(inserted[0]).sort(), ['amount_kes', 'id', 'member_id', 'minutes', 'phone_number', 'seconds_credited'].sort());
    assert.equal(inserted[0].amount_kes, 100);
    assert.equal(inserted[0].phone_number, '254712345678');
    assert.equal(inserted[0].seconds_credited, 2100);
    assert.equal('session_id' in inserted[0], false);

    const mismatch = makeResponse();
    await handler({ method: 'POST', cookies: { vp_session: 'opaque-session-token' }, body: { phone: '0712345678', amount: 200, minutes: 35 } }, mismatch);
    assert.equal(mismatch.statusCode, 400);
    assert.equal(inserted.length, 1);
    assert.equal(stkCalls, 1);

    const unsupported = makeResponse();
    await handler({ method: 'POST', cookies: { vp_session: 'opaque-session-token' }, body: { phone: '0712345678', amount: 999, minutes: 99 } }, unsupported);
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.body.error, 'Unsupported package');
    assert.equal(inserted.length, 1);
    assert.equal(stkCalls, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('callback success without independent matching STK Query never credits', async () => {
  let credits = 0;
  const db = {
    getPaymentByCheckoutRequestId: async () => payment,
    confirmPayment: async () => { credits += 1; return { status: 'paid' }; },
    failPayment: async () => ({ status: 'failed' })
  };
  const handler = createCallbackHandler({ db, query: async () => ({ ok: false, data: {} }) });
  const res = makeResponse();
  await handler(callbackRequest(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(credits, 0);
});

test('callback is cross-checked against query and callback metadata before atomic confirmation', async () => {
  let status = 'pending';
  let queries = 0;
  let credits = 0;
  const db = {
    getPaymentByCheckoutRequestId: async () => ({ ...payment, status }),
    confirmPayment: async () => { credits += 1; status = 'paid'; return { status }; },
    failPayment: async () => ({ status: 'failed' })
  };
  const handler = createCallbackHandler({
    db,
    query: async ({ checkoutRequestId }) => {
      queries += 1;
      return { ok: true, data: { CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'Confirmed' } };
    }
  });

  const first = makeResponse();
  await handler(callbackRequest(), first);
  const duplicate = makeResponse();
  await handler(callbackRequest(), duplicate);
  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(queries, 1);
  assert.equal(credits, 1);

  const mismatched = makeResponse();
  const mismatchHandler = createCallbackHandler({
    db: { ...db, getPaymentByCheckoutRequestId: async () => payment, confirmPayment: async () => { credits += 1; } },
    query: async ({ checkoutRequestId }) => ({ ok: true, data: { CheckoutRequestID: checkoutRequestId, ResultCode: 0 } })
  });
  await mismatchHandler(callbackRequest({ CallbackMetadata: { Item: [{ Name: 'Amount', Value: 999 }] } }), mismatched);
  assert.equal(credits, 1);
});

test('callback metadata must match stored package amount and phone', () => {
  const callback = callbackRequest().body.Body.stkCallback;
  assert.equal(callbackMatchesPayment(callback, payment), true);
  assert.equal(callbackMatchesPayment({ ...callback, CallbackMetadata: { Item: [{ Name: 'Amount', Value: 999 }] } }, payment), false);
});

test('payment status lookup is scoped to the authenticated member', async () => {
  let requestedMemberId;
  let credits = 0;
  const db = {
    getMemberBySessionToken: async () => member,
    getPaymentForMember: async (id, memberId) => {
      requestedMemberId = memberId;
      return { ...payment, id, status: 'pending' };
    },
    confirmPayment: async () => { credits += 1; return { status: 'paid' }; },
    failPayment: async () => ({ status: 'failed' })
  };
  const handler = createPaymentStatusHandler({
    db,
    query: async ({ checkoutRequestId }) => ({ ok: true, data: { CheckoutRequestID: checkoutRequestId, ResultCode: 0 } })
  });
  const res = makeResponse();
  await handler({ method: 'GET', params: { id: payment.id }, cookies: { vp_session: 'opaque' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(requestedMemberId, member.id);
  assert.equal(credits, 1);
});

test('video usage is member-authenticated, bounded, and requires a playing-session event', async () => {
  const calls = [];
  const db = {
    getMemberBySessionToken: async (token) => token ? member : null,
    startVideoSession: async (memberId, id, creator) => {
      calls.push(['start', memberId, id, creator]);
      return { video_session_id: id, status: 'paused', balance_seconds: 900 };
    },
    recordVideoUsage: async (...args) => { calls.push(['usage', ...args]); return { balance_seconds: 892, deducted_seconds: 8 }; },
    setVideoSessionState: async (...args) => { calls.push(['state', ...args]); return { status: args[2], balance_seconds: 900 }; }
  };
  const handler = createVideoUsageHandler({ db });
  const start = makeResponse();
  await handler({ method: 'POST', cookies: { vp_session: 'opaque' }, body: { action: 'start', creator: 'Emmah' } }, start);
  const sessionId = start.body.video_session_id;
  assert.equal(start.statusCode, 200);
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);

  const invalid = makeResponse();
  await handler({ method: 'POST', cookies: { vp_session: 'opaque' }, body: { action: 'usage', video_session_id: sessionId, seconds: 16, idempotency_key: crypto.randomUUID() } }, invalid);
  assert.equal(invalid.statusCode, 400);

  const paused = makeResponse();
  await handler({ method: 'POST', cookies: { vp_session: 'opaque' }, body: { action: 'pause', video_session_id: sessionId } }, paused);
  assert.equal(paused.statusCode, 200);
  assert.equal(calls.filter(([kind]) => kind === 'usage').length, 0);

  const usage = makeResponse();
  await handler({ method: 'POST', cookies: { vp_session: 'opaque' }, body: { action: 'usage', video_session_id: sessionId, seconds: 8, idempotency_key: crypto.randomUUID() } }, usage);
  assert.equal(usage.statusCode, 200);
  assert.equal(calls.filter(([kind]) => kind === 'usage').length, 1);

  const preview = makeResponse();
  await handler({ method: 'POST', cookies: { vp_session: 'opaque' }, body: { action: 'preview', creator: 'Emmah', seconds: 30 } }, preview);
  assert.equal(preview.statusCode, 400);
  assert.equal(calls.filter(([kind]) => kind === 'usage').length, 1);

  const unauthenticated = makeResponse();
  await handler({ method: 'POST', cookies: {}, body: { action: 'start', creator: 'Emmah' } }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
});

test('migrations preserve existing tables, deny browser access, and encode atomic wallet operations', () => {
  const migrationDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const core = fs.readFileSync(path.join(migrationDir, '202611050001_create_velvetplay_core_schema.sql'), 'utf8');
  const rls = fs.readFileSync(path.join(migrationDir, '202611050002_create_velvetplay_rls.sql'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const serverStore = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supabase.js'), 'utf8');

  assert.doesNotMatch(core, /create table if not exists public\.(vp_members|vp_payments|vp_ledger)\b/i);
  assert.doesNotMatch(core, /\bsession_id\b|\bminutes_balance\b|\bamount\s+numeric|\bphone\s+text/i);
  assert.match(serverStore, /session_token_hash/);
  assert.match(core, /balance_seconds\s*=\s*balance_seconds\s*-\s*p_seconds/);
  assert.match(core, /balance_seconds\s*=\s*balance_seconds\s*\+\s*v_payment\.seconds_credited/);
  assert.match(core, /seconds_delta/);
  assert.match(core, /on conflict\s*\(idempotency_key\)/i);
  assert.match(core, /v_session\.status\s*<>\s*'playing'/i);
  assert.match(core, /for update/i);
  assert.match(core, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.doesNotMatch(rls, /create policy/i);
  assert.match(rls, /drop policy if exists "vp_members_update_own"/i);
  assert.match(rls, /revoke all on table public\.vp_ledger from public, anon, authenticated/i);
  for (const table of ['vp_members', 'vp_payments', 'vp_ledger', 'vp_video_sessions']) {
    assert.match(rls, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.doesNotMatch(browser, /SUPABASE_SERVICE_ROLE_KEY|MPESA_CONSUMER_SECRET|MPESA_PASSKEY/);
  const promoCode = browser.slice(browser.indexOf('function initializePromoVideo'), browser.indexOf('function closePromoVideo'));
  assert.doesNotMatch(promoCode, /enqueueVideoEvent|api\/video\/usage/);
  assert.doesNotMatch(serverStore, /\.from\('vp_members'\)\s*\.update/);
});
