const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

let cachedClient;

function getSupabaseClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  return cachedClient;
}

function requireClient(client = getSupabaseClient()) {
  if (!client) throw new Error('Supabase server credentials are not configured');
  return client;
}

function asNumber(value, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length < 32) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getMemberBySessionToken(token, client) {
  const tokenHash = hashSessionToken(token);
  if (!tokenHash) return null;

  const { data, error } = await requireClient(client)
    .from('vp_members')
    .select('id,session_expires_at,balance_seconds,created_at,updated_at')
    .eq('session_token_hash', tokenHash)
    .gt('session_expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createMemberSession(token, expiresAt, client) {
  const tokenHash = hashSessionToken(token);
  if (!tokenHash) throw new Error('Invalid session token');

  const { data, error } = await requireClient(client)
    .from('vp_members')
    .insert({ session_token_hash: tokenHash, session_expires_at: expiresAt, balance_seconds: 0 })
    .select('id,session_expires_at,balance_seconds,created_at,updated_at')
    .single();

  if (error) throw error;
  return data;
}

async function getPaymentForMember(paymentId, memberId, client) {
  const { data, error } = await requireClient(client)
    .from('vp_payments')
    .select('id,member_id,amount_kes,minutes,seconds_credited,phone_number,status,merchant_request_id,checkout_request_id,mpesa_receipt,result_code,result_description,created_at,paid_at')
    .eq('id', paymentId)
    .eq('member_id', memberId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getPaymentByCheckoutRequestId(checkoutRequestId, client) {
  const { data, error } = await requireClient(client)
    .from('vp_payments')
    .select('id,member_id,amount_kes,minutes,seconds_credited,phone_number,status,merchant_request_id,checkout_request_id,mpesa_receipt,result_code,result_description,created_at,paid_at')
    .eq('checkout_request_id', checkoutRequestId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createPayment(payment, client) {
  const { data, error } = await requireClient(client)
    .from('vp_payments')
    .insert({
      id: payment.id,
      member_id: payment.member_id,
      amount_kes: payment.amount_kes,
      minutes: payment.minutes,
      seconds_credited: payment.seconds_credited,
      phone_number: payment.phone_number,
      status: 'pending'
    })
    .select('id,member_id,amount_kes,minutes,seconds_credited,phone_number,status,checkout_request_id,merchant_request_id')
    .single();

  if (error) throw error;
  return data;
}

async function attachCheckoutRequest(paymentId, checkoutRequestId, merchantRequestId, client) {
  const { data, error } = await requireClient(client)
    .from('vp_payments')
    .update({ checkout_request_id: checkoutRequestId, merchant_request_id: merchantRequestId })
    .eq('id', paymentId)
    .select('id,checkout_request_id,merchant_request_id,status')
    .single();

  if (error) throw error;
  return data;
}

async function markPaymentRequestFailed(paymentId, resultDescription, client) {
  const { data, error } = await requireClient(client)
    .from('vp_payments')
    .update({ status: 'failed', result_description: resultDescription })
    .eq('id', paymentId)
    .eq('status', 'pending')
    .select('id,status')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function confirmPayment(checkoutRequestId, receipt, description, callbackPayload, client) {
  const { data, error } = await requireClient(client).rpc('vp_confirm_payment', {
    p_checkout_request_id: checkoutRequestId,
    p_mpesa_receipt: receipt || null,
    p_result_description: description || 'Payment confirmed by Safaricom STK Query',
    p_callback_payload: callbackPayload || null
  });

  if (error) throw error;
  return data;
}

async function failPayment(checkoutRequestId, resultCode, description, callbackPayload, client) {
  const { data, error } = await requireClient(client).rpc('vp_fail_payment', {
    p_checkout_request_id: checkoutRequestId,
    p_result_code: resultCode,
    p_result_description: description || 'Payment failed',
    p_callback_payload: callbackPayload || null
  });

  if (error) throw error;
  return data;
}

async function startVideoSession(memberId, videoSessionId, creatorName, client) {
  const { data, error } = await requireClient(client).rpc('vp_start_video_session', {
    p_member_id: memberId,
    p_video_session_id: videoSessionId,
    p_creator_name: creatorName
  });

  if (error) throw error;
  return data;
}

async function recordVideoUsage(memberId, videoSessionId, seconds, idempotencyKey, client) {
  const { data, error } = await requireClient(client).rpc('vp_record_video_usage', {
    p_member_id: memberId,
    p_video_session_id: videoSessionId,
    p_seconds: seconds,
    p_idempotency_key: idempotencyKey
  });

  if (error) throw error;
  return data;
}

async function setVideoSessionState(memberId, videoSessionId, action, client) {
  const { data, error } = await requireClient(client).rpc('vp_set_video_session_state', {
    p_member_id: memberId,
    p_video_session_id: videoSessionId,
    p_action: action
  });

  if (error) throw error;
  return data;
}

module.exports = {
  getSupabaseClient,
  hashSessionToken,
  getMemberBySessionToken,
  createMemberSession,
  getPaymentForMember,
  getPaymentByCheckoutRequestId,
  createPayment,
  attachCheckoutRequest,
  markPaymentRequestFailed,
  confirmPayment,
  failPayment,
  startVideoSession,
  recordVideoUsage,
  setVideoSessionState,
  asNumber
};
