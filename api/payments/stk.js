const crypto = require('crypto');
const store = require('../../lib/supabase');
const { normalizeKenyanPhone, isValidKenyanPhone } = require('../../lib/phone');
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
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const member = await db.getMemberBySessionToken(req.cookies?.vp_session);
      if (!member) return res.status(401).json({ error: 'No active session' });

      const { phone, amount, minutes } = req.body || {};
      const normalizedPhone = normalizeKenyanPhone(phone);
      const numericAmount = Number(amount);
      const numericMinutes = Number(minutes);
      const expectedPrice = PACKAGE_PRICES[numericMinutes];

      if (!normalizedPhone || !isValidKenyanPhone(normalizedPhone)) {
        return res.status(400).json({ error: 'Invalid M-Pesa phone number' });
      }
      if (!Number.isInteger(numericMinutes) || !expectedPrice) {
        return res.status(400).json({ error: 'Unsupported package' });
      }
      if (!Number.isInteger(numericAmount) || expectedPrice !== numericAmount) {
        return res.status(400).json({ error: 'Package amount mismatch' });
      }

      const env = process.env.MPESA_ENVIRONMENT || 'sandbox';
      if (!['sandbox', 'production'].includes(env)) {
        return res.status(500).json({ error: 'Invalid M-Pesa environment configuration' });
      }

      const shortcode = process.env.MPESA_TILL_NUMBER || process.env.MPESA_SHORTCODE;
      const callbackUrl = process.env.MPESA_CALLBACK_URL;
      const passkey = process.env.MPESA_PASSKEY;
      if (!shortcode || !callbackUrl || !passkey) {
        return res.status(500).json({ error: 'M-Pesa merchant configuration is incomplete' });
      }

      const token = await tokenProvider();
      const timestamp = getDarajaTimestamp();
      const password = buildPassword(shortcode, passkey, timestamp);
      const transactionType = process.env.MPESA_TRANSACTION_TYPE ||
        (process.env.MPESA_TILL_NUMBER ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline');

      paymentId = crypto.randomUUID();
      await db.createPayment({
        id: paymentId,
        member_id: member.id,
        amount_kes: numericAmount,
        minutes: numericMinutes,
        seconds_credited: numericMinutes * 60,
        phone_number: normalizedPhone
      });

      const response = await fetchImpl(
        `${getDarajaBaseUrl(env)}/mpesa/stkpush/v1/processrequest`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: transactionType,
            Amount: numericAmount,
            PartyA: normalizedPhone,
            PartyB: shortcode,
            PhoneNumber: normalizedPhone,
            CallBackURL: callbackUrl,
            AccountReference: 'VelvetPlay',
            TransactionDesc: 'VelvetPlay minutes'
          })
        }
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.CheckoutRequestID) {
        await db.markPaymentRequestFailed(paymentId, data.errorMessage || 'STK request was rejected');
        return res.status(400).json({ error: 'Could not start M-Pesa payment' });
      }

      await db.attachCheckoutRequest(paymentId, data.CheckoutRequestID, data.MerchantRequestID || null);
      return res.status(200).json({ payment_id: paymentId, status: 'pending' });
    } catch (error) {
      return res.status(500).json({ error: 'Payment service error' });
    }
  };
}

module.exports = createStkHandler();
module.exports.createStkHandler = createStkHandler;
module.exports.PACKAGE_PRICES = PACKAGE_PRICES;
