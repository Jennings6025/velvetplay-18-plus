const { kv } = require('./kv');
const { applyWalletCredit, getProfileBySession } = require('./supabase');

function getDarajaBaseUrl(env = process.env.MPESA_ENVIRONMENT || 'sandbox') {
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function getDarajaTimestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function buildPassword(shortcode, passkey, timestamp) {
  if (!shortcode || !passkey) return '';
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

async function getDarajaToken() {
  const env = process.env.MPESA_ENVIRONMENT || 'sandbox';
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error(
      env === 'production'
        ? 'Production M-Pesa credentials are not configured.'
        : 'Sandbox M-Pesa credentials are not configured.'
    );
  }

  const baseUrl = getDarajaBaseUrl(env);
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');

  const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });

  if (!response.ok) {
    throw new Error('Could not authenticate with M-Pesa');
  }

  const data = await response.json();
  return data.access_token;
}

async function queryStkPush({ checkoutRequestId, env = process.env.MPESA_ENVIRONMENT || 'sandbox' }) {
  if (!checkoutRequestId) {
    throw new Error('CheckoutRequestID is required');
  }

  const businessShortCode = process.env.MPESA_TILL_NUMBER || process.env.MPESA_SHORTCODE;
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = getDarajaTimestamp();
  const password = buildPassword(businessShortCode, passkey, timestamp);

  if (env === 'production' && (!businessShortCode || !passkey || !shortcode)) {
    throw new Error('Production M-Pesa merchant configuration is not fully configured.');
  }

  const token = await getDarajaToken();
  const response = await fetch(`${getDarajaBaseUrl(env)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    })
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

async function creditUserMinutes(sessionId, minutes, paymentId = null, metadata = {}) {
  if (!sessionId || !Number.isFinite(Number(minutes))) return false;

  const existingProfile = await getProfileBySession(sessionId);
  if (!existingProfile) {
    const user = await kv.get(`user:${sessionId}`);
    if (!user) return false;
    user.minutes_balance = Number(user.minutes_balance || 0) + Number(minutes);
    await kv.set(`user:${sessionId}`, user);
    return true;
  }

  await applyWalletCredit(sessionId, Number(minutes), paymentId, {
    ...metadata,
    amount: metadata.amount ?? 0,
    reference: metadata.reference || paymentId || null
  });
  return true;
}

module.exports = {
  getDarajaBaseUrl,
  getDarajaTimestamp,
  buildPassword,
  getDarajaToken,
  queryStkPush,
  creditUserMinutes
};
