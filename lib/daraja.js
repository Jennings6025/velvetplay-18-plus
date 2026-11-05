const { normalizeKenyanPhone } = require('./phone');

function getDarajaBaseUrl(env = process.env.MPESA_ENVIRONMENT || 'sandbox') {
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function getDarajaTimestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function buildPassword(shortcode, passkey, timestamp) {
  if (!shortcode || !passkey || !timestamp) return '';
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

async function getDarajaToken() {
  const env = process.env.MPESA_ENVIRONMENT || 'sandbox';
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error(env === 'production'
      ? 'Production M-Pesa credentials are not configured.'
      : 'Sandbox M-Pesa credentials are not configured.');
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await fetch(
    `${getDarajaBaseUrl(env)}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  if (!response.ok) throw new Error('Could not authenticate with M-Pesa');

  const data = await response.json();
  if (!data.access_token) throw new Error('M-Pesa returned no access token');
  return data.access_token;
}

async function queryStkPush({
  checkoutRequestId,
  env = process.env.MPESA_ENVIRONMENT || 'sandbox'
}) {
  if (!checkoutRequestId) throw new Error('CheckoutRequestID is required');

  const businessShortCode = process.env.MPESA_TILL_NUMBER || process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  if (!businessShortCode || !passkey) {
    throw new Error('M-Pesa merchant configuration is not fully configured.');
  }

  const timestamp = getDarajaTimestamp();
  const password = buildPassword(businessShortCode, passkey, timestamp);
  const token = await getDarajaToken();
  const response = await fetch(`${getDarajaBaseUrl(env)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
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

function isSuccessfulStkQuery(query, expectedCheckoutRequestId) {
  const resultCode = query?.data?.ResultCode;
  return query?.ok === true &&
    query.data?.CheckoutRequestID === expectedCheckoutRequestId &&
    resultCode !== null && resultCode !== undefined && Number(resultCode) === 0;
}

function callbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;
  return Array.isArray(items)
    ? Object.fromEntries(items.filter((item) => item?.Name).map((item) => [item.Name, item.Value]))
    : {};
}

function callbackMatchesPayment(callback, payment) {
  if (callback?.ResultCode === null || callback?.ResultCode === undefined ||
      Number(callback.ResultCode) !== 0 ||
      callback?.CheckoutRequestID !== payment.checkout_request_id) return false;

  const metadata = callbackMetadata(callback);
  if (metadata.Amount !== undefined && Number(metadata.Amount) !== Number(payment.amount_kes)) {
    return false;
  }
  if (metadata.PhoneNumber !== undefined &&
      normalizeKenyanPhone(metadata.PhoneNumber) !== normalizeKenyanPhone(payment.phone_number)) {
    return false;
  }
  return true;
}

function getCallbackReceipt(callback) {
  return callbackMetadata(callback).MpesaReceiptNumber || null;
}

module.exports = {
  getDarajaBaseUrl,
  getDarajaTimestamp,
  buildPassword,
  getDarajaToken,
  queryStkPush,
  isSuccessfulStkQuery,
  callbackMatchesPayment,
  getCallbackReceipt
};
