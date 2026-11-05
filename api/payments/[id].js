const store = require('../../lib/supabase');
const { queryStkPush, isSuccessfulStkQuery } = require('../../lib/daraja');

function createPaymentStatusHandler({ db = store, query = queryStkPush } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const member = await db.getMemberBySessionToken(req.cookies?.vp_session);
      if (!member) return res.status(401).json({ error: 'No active session' });

      const paymentId = req.params?.id || req.query?.id;
      if (!paymentId) return res.status(400).json({ error: 'Payment ID is required' });

      const payment = await db.getPaymentForMember(paymentId, member.id);
      if (!payment) return res.status(404).json({ error: 'Payment not found' });

      if (payment.status === 'pending' && payment.checkout_request_id) {
        const verification = await query({ checkoutRequestId: payment.checkout_request_id });
        const queryCheckoutId = verification?.data?.CheckoutRequestID;
        const rawQueryCode = verification?.data?.ResultCode;
        const queryCode = Number(rawQueryCode);

        if (isSuccessfulStkQuery(verification, payment.checkout_request_id)) {
          const result = await db.confirmPayment(
            payment.checkout_request_id,
            null,
            verification.data.ResultDesc || 'Payment confirmed by Safaricom STK Query',
            null
          );
          payment.status = result?.status || payment.status;
        } else if (verification?.ok === true && queryCheckoutId === payment.checkout_request_id &&
          rawQueryCode !== null && rawQueryCode !== undefined && Number.isInteger(queryCode)) {
          const result = await db.failPayment(
            payment.checkout_request_id,
            queryCode,
            verification.data.ResultDesc || 'Payment failed',
            null
          );
          payment.status = result?.status || payment.status;
        }
      }

      return res.status(200).json({
        payment_id: payment.id,
        status: payment.status,
        amount_kes: Number(payment.amount_kes),
        minutes: Number(payment.minutes)
      });
    } catch (error) {
      return res.status(500).json({ error: 'Could not check payment' });
    }
  };
}

module.exports = createPaymentStatusHandler();
module.exports.createPaymentStatusHandler = createPaymentStatusHandler;
