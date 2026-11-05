const { kv } = require("../../lib/kv");
const crypto = require("crypto");
const { normalizeKenyanPhone, isValidKenyanPhone } = require("../../lib/phone");
const { getDarajaToken, getDarajaBaseUrl, getDarajaTimestamp, buildPassword } = require("../../lib/daraja");

function getSessionId(req) {
  return (req.cookies || {}).vp_session || null;
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

    const packageConfig = {
      35: 100,
      50: 150,
      70: 200,
      100: 250,
      130: 300,
      160: 350
    };

    const { phone, amount, minutes } = req.body || {};

    const normalizedPhone = normalizeKenyanPhone(phone);
    const numericAmount = Number(amount);
    const numericMinutes = Number(minutes);

    if (!normalizedPhone || !isValidKenyanPhone(normalizedPhone)) {
      return res.status(400).json({ error: "Invalid M-Pesa phone number" });
    }

    if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    if (!Number.isInteger(numericMinutes) || numericMinutes <= 0) {
      return res.status(400).json({ error: "Invalid minutes package" });
    }

    const allowedAmount = packageConfig[numericMinutes];
    if (allowedAmount && numericAmount !== allowedAmount) {
      return res.status(400).json({ error: "Package amount mismatch" });
    }
    if (!allowedAmount) {
      return res.status(400).json({ error: "Unsupported package" });
    }

    const env = process.env.MPESA_ENVIRONMENT || "sandbox";
    const merchantBusinessShortCode = process.env.MPESA_TILL_NUMBER || process.env.MPESA_SHORTCODE;
    const requiredKeys = [
      "MPESA_CONSUMER_KEY",
      "MPESA_CONSUMER_SECRET",
      "MPESA_PASSKEY"
    ];

    if (env === "production") {
      const missing = requiredKeys.filter((name) => !process.env[name]);
      if (missing.length || !merchantBusinessShortCode || !process.env.MPESA_CALLBACK_URL) {
        return res.status(500).json({
          error: "Production M-Pesa credentials, merchant configuration, and callback URL are not fully configured."
        });
      }
    }

    const token = await getDarajaToken();
    const timestamp = getDarajaTimestamp();
    const transactionType = process.env.MPESA_TRANSACTION_TYPE || (process.env.MPESA_TILL_NUMBER ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline");
    const password = buildPassword(merchantBusinessShortCode, process.env.MPESA_PASSKEY, timestamp);
    const stkUrl = `${getDarajaBaseUrl(env)}/mpesa/stkpush/v1/processrequest`;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    if (!callbackUrl && env === "sandbox") {
      return res.status(500).json({
        error: "M-Pesa callback URL is not configured"
      });
    }

    const stkResponse = await fetch(stkUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        BusinessShortCode: merchantBusinessShortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: transactionType,
        Amount: numericAmount,
        PartyA: normalizedPhone,
        PartyB: merchantBusinessShortCode,
        PhoneNumber: normalizedPhone,
        CallBackURL: callbackUrl,
        AccountReference: "VelvetPlay",
        TransactionDesc: "VelvetPlay minutes"
      })
    });

    const stkData = await stkResponse.json().catch(() => ({}));

    if (!stkResponse.ok || !stkData.CheckoutRequestID) {
      return res.status(400).json({
        error: stkData.errorMessage || "Could not start M-Pesa payment"
      });
    }

    const paymentId = crypto.randomUUID();

    const payment = {
      payment_id: paymentId,
      session_id: sessionId,
      phone: normalizedPhone,
      amount: numericAmount,
      minutes: numericMinutes,
      status: "pending",
      checkout_request_id: stkData.CheckoutRequestID,
      merchant_request_id: stkData.MerchantRequestID,
      created_at: new Date().toISOString()
    };

    await kv.set(`payment:${paymentId}`, payment);
    await kv.set(`checkout:${stkData.CheckoutRequestID}`, paymentId);

    return res.status(200).json({
      payment_id: paymentId,
      status: "pending"
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Payment service error"
    });
  }
};