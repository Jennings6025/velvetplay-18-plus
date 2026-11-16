
const { normalizeKenyanPhone } = require('./phone');

function getDarajaEnvironment() {
  const env = String(process.env.MPESA_ENVIRONMENT || '')
    .trim()
    .toLowerCase();

  if (env !== 'production') {
    throw new Error(
      'Live M-Pesa production environment is not configured.'
    );
  }

  return env;
}

function getDarajaBaseUrl(env = getDarajaEnvironment()) {
  if (env !== 'production') {
    throw new Error('Only production Daraja is enabled.');
  }

  return 'https://api.safaricom.co.ke';
}

// Always generate the timestamp in Kenya time,
// regardless of the Vercel server timezone.
function getDarajaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const get = (type) =>
    parts.find(part => part.type === type).value;

  return (
    get('year') +
    get('month') +
    get('day') +
    get('hour') +
    get('minute') +
    get('second')
  );
}

function buildPassword(shortcode, passkey, timestamp) {
  if (!shortcode || !passkey || !timestamp) {
    throw new Error(
      'Incomplete M-Pesa password configuration.'
    );
  }

  return Buffer.from(
    `${shortcode}${passkey}${timestamp}`
  ).toString('base64');
}

async function getDarajaToken() {
  const env = getDarajaEnvironment();
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error(
      'Production M-Pesa credentials are missing.'
    );
  }

  const auth = Buffer.from(
    `${key}:${secret}`
  ).toString('base64');

  const response = await fetch(
    `${getDarajaBaseUrl(env)}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw new Error(
      'Could not authenticate with production M-Pesa.'
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(
      'M-Pesa returned no access token.'
    );
  }

  return data.access_token;
}

async function queryStkPush({ checkoutRequestId }) {
  if (!checkoutRequestId) {
    throw new Error('CheckoutRequestID is required.');
  }

  const businessShortCode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;

  if (!businessShortCode || !passkey) {
    throw new Error(
      'Production merchant configuration is incomplete.'
    );
  }

  const env = getDarajaEnvironment();
  const timestamp = getDarajaTimestamp();

  const password = buildPassword(
    businessShortCode,
    passkey,
    timestamp
  );

  const token = await getDarajaToken();

  const response = await fetch(
    `${getDarajaBaseUrl(env)}/mpesa/stkpushquery/v1/query`,
    {
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
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    data
  };
}

function isSuccessfulStkQuery(query, expectedCheckoutRequestId) {
  const resultCode = query?.data?.ResultCode;

  return (
    query?.ok === true &&
    query.data?.CheckoutRequestID === expectedCheckoutRequestId &&
    resultCode !== null &&
    resultCode !== undefined &&
    Number(resultCode) === 0
  );
}

function callbackMetadata(callback) {
  const items = callback?.CallbackMetadata?.Item;

  return Array.isArray(items)
    ? Object.fromEntries(
        items
          .filter(item => item?.Name)
          .map(item => [item.Name, item.Value])
      )
    : {};
}

function callbackMatchesPayment(callback, payment) {
  if (
    callback?.ResultCode === null ||
    callback?.ResultCode === undefined ||
    Number(callback.ResultCode) !== 0 ||
    callback?.CheckoutRequestID !== payment.checkout_request_id
  ) {
    return false;
  }

  if (
    payment.merchant_request_id &&
    callback.MerchantRequestID !== payment.merchant_request_id
  ) {
    return false;
  }

  const metadata = callbackMetadata(callback);

  if (
    metadata.Amount === undefined ||
    Number(metadata.Amount) !== Number(payment.amount_kes)
  ) {
    return false;
  }

  if (
    metadata.PhoneNumber === undefined ||
    normalizeKenyanPhone(metadata.PhoneNumber) !==
      normalizeKenyanPhone(payment.phone_number)
  ) {
    return false;
  }

  if (!metadata.MpesaReceiptNumber) {
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
