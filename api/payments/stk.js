
const crypto = require('crypto');
const store = require('../../lib/supabase');
const {
  normalizeKenyanPhone,
  isValidKenyanPhone
} = require('../../lib/phone');

const {
  getDarajaToken,
  getDarajaBaseUrl,
  getDarajaTimestamp,
  buildPassword
} = require('../../lib/daraja');

const PACKAGE_PRICES = Object.freeze({
  35: 100,
  50: 150,
  70: 200,
  100: 250,
  130: 300,
  160: 350
});

function createStkHandler({
  db = store,
  fetchImpl = (...args) => fetch(...args),
  tokenProvider = getDarajaToken
} = {}) {
  return async (req, res) => {
    let paymentId = null;

    try {
      if (req.method !== 'POST') {
        return res.status(405).json({
          error: 'Method not allowed'
        });
      }

      const member = await db.getMemberBySessionToken(
        req.cookies?.vp_session
      );

      if (!member) {
        return res.status(401).json({
          error: 'No active session'
        });
      }

      const { phone, amount, minutes } = req.body || {};

      const normalizedPhone = normalizeKenyanPhone(phone);
      const numericAmount = Number(amount);
      const numericMinutes = Number(minutes);
      const expectedPrice = PACKAGE_PRICES[numericMinutes];

      if (
        !normalizedPhone ||
        !isValidKenyanPhone(normalizedPhone)
      ) {
        return res.status(400).json({
          error: 'Invalid M-Pesa phone number'
        });
      }

      if (
        !Number.isInteger(numericMinutes) ||
        !expectedPrice
      ) {
        return res.status(400).json({
          error: 'Unsupported package'
        });
      }

      if (
        !Number.isInteger(numericAmount) ||
        numericAmount !== expectedPrice
      ) {
        return res.status(400).json({
          error: 'Package amount mismatch'
        });
      }

      // Production configuration only.
      const environment = String(
        process.env.MPESA_ENVIRONMENT || ''
      ).trim().toLowerCase();

      if (environment !== 'production') {
        return res.status(503).json({
          error: 'Production M-Pesa is not configured'
        });
      }

      // VelvetPlay production merchant details.
      const businessShortCode = process.env.MPESA_SHORTCODE;
      const tillNumber = process.env.MPESA_TILL_NUMBER;
      const callbackUrl = process.env.MPESA_CALLBACK_URL;
      const passkey = process.env.MPESA_PASSKEY;

      if (
        businessShortCode !== '8417067' ||
        tillNumber !== '6918611' ||
        !callbackUrl ||
        !passkey
      ) {
        return res.status(503).json({
          error: 'Production merchant configuration is incomplete'
        });
      }

      let callback;

      try {
        callback = new URL(callbackUrl);
      } catch {
        return res.status(503).json({
          error: 'Invalid M-Pesa callback URL'
        });
      }

      if (callback.protocol !== 'https:') {
        return res.status(503).json({
          error: 'M-Pesa callback must use HTTPS'
        });
      }

      const timestamp = getDarajaTimestamp();

      const password = buildPassword(
        businessShortCode,
        passkey,
        timestamp
      );

      const token = await tokenProvider();

      paymentId = crypto.randomUUID();

      // Save pending payment before requesting STK Push.
      await db.createPayment({
        id: paymentId,
        member_id: member.id,
        amount_kes: numericAmount,
        minutes: numericMinutes,
        seconds_credited: numericMinutes * 60,
        phone_number: normalizedPhone
      });
function getSessionId(req) {
  return (req.cookies || {}).vp_session || null;
}

async function getDarajaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const env = process.env.MPESA_ENVIRONMENT || "sandbox";

  const url =
    env === "production"
      ? "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
      : "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });

  if (!response.ok) {
    throw new Error("Could not authenticate with M-Pesa");
  }

  const data = await response.json();
  return data.access_token;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const sessionId = getSessionId(req);

    if (!sessionId) {
      return res.status(401).json({ error: "No active session" });
    }

    const user = await kv.get(`user:${sessionId}`);

    if (!user) {
      return res.status(401).json({ error: "Session expired" });
    }

    const { phone, amount, minutes } = req.body || {};

    const normalizedPhone = String(phone || "").replace(/\D/g, "");
    const numericAmount = Number(amount);
    const numericMinutes = Number(minutes);

    if (!/^254[17]\d{8}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: "Invalid M-Pesa phone number" });
    }

    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    if (!Number.isInteger(numericMinutes) || numericMinutes <= 0) {
      return res.status(400).json({ error: "Invalid minutes package" });
    }

    const env = process.env.MPESA_ENVIRONMENT || "sandbox";
    const token = await getDarajaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

      const response = await fetchImpl(
        `${getDarajaBaseUrl('production')}/mpesa/stkpush/v1/processrequest`,
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
            TransactionType: 'CustomerBuyGoodsOnline',
            Amount: numericAmount,
            PartyA: normalizedPhone,
            PartyB: tillNumber,
            PhoneNumber: normalizedPhone,
            CallBackURL: callbackUrl,
            AccountReference: 'VelvetPlay',
            TransactionDesc: 'VelvetPlay'
          }),
          signal: AbortSignal.timeout(20000)
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.CheckoutRequestID) {
        await db.markPaymentRequestFailed(
          paymentId,
          data.errorMessage ||
            'Safaricom rejected the STK request'
        );

        return res.status(502).json({
          error: 'Safaricom could not initiate the payment'
        });
      }

      await db.attachCheckoutRequest(
        paymentId,
        data.CheckoutRequestID,
        data.MerchantRequestID || null
      );

      return res.status(200).json({
        payment_id: paymentId,
        status: 'pending',
        message: 'M-Pesa payment request initiated'
      });

    } catch (error) {
      console.error(
        'M-Pesa STK initiation error:',
        error.message
      );

      return res.status(500).json({
        error: 'Payment service temporarily unavailable'
      });
    }
  };
}

module.exports = createStkHandler();
module.exports.createStkHandler = createStkHandler;
module.exports.PACKAGE_PRICES = PACKAGE_PRICES;
