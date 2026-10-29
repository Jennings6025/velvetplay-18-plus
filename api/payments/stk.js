const { kv } = require("@vercel/kv");
const crypto = require("crypto");

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

    const normalizedPhone = String(phone || "").replace(/D/g, "");
    const numericAmount = Number(amount);
    const numericMinutes = Number(minutes);

    if (!/^254[17]d{8}$/.test(normalizedPhone)) {
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

    const stkUrl =
      env === "production"
        ? "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
        : "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    if (!callbackUrl) {
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
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: numericAmount,
        PartyA: normalizedPhone,
        PartyB: process.env.MPESA_SHORTCODE,
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