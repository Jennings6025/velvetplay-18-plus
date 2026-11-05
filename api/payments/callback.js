const store = require('../../lib/supabase');
const {
  queryStkPush,
  isSuccessfulStkQuery,
  callbackMatchesPayment,
  getCallbackReceipt
} = require('../../lib/daraja');

function accepted(res) {
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

function createCallbackHandler({ db = store, query = queryStkPush } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ ResultCode: 1, ResultDesc: 'Method not allowed' });
      }

      const callback = req.body?.Body?.stkCallback;
      const checkoutRequestId = callback?.CheckoutRequestID;
        if (!checkoutRequestId || callback.ResultCode === null || callback.ResultCode === undefined ||
          !Number.isInteger(Number(callback.ResultCode))) {
        return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback' });
      }

      const payment = await db.getPaymentByCheckoutRequestId(checkoutRequestId);
      if (!payment || payment.status !== 'pending') return accepted(res);

      const verification = await query({ checkoutRequestId });
      const queryCheckoutId = verification?.data?.CheckoutRequestID;
        const rawQueryCode = verification?.data?.ResultCode;
        const queryCode = Number(rawQueryCode);
        if (verification?.ok !== true || queryCheckoutId !== checkoutRequestId ||
          rawQueryCode === null || rawQueryCode === undefined || !Number.isInteger(queryCode)) {
        return res.status(502).json({ ResultCode: 1, ResultDesc: 'Payment verification is unavailable' });
      }

      if (isSuccessfulStkQuery(verification, checkoutRequestId)) {
        if (!callbackMatchesPayment(callback, payment)) return accepted(res);

        const result = await db.confirmPayment(
          checkoutRequestId,
          getCallbackReceipt(callback),
          verification.data.ResultDesc || callback.ResultDesc,
          req.body
        );
        if (result?.status !== 'paid') {
          return res.status(503).json({ ResultCode: 1, ResultDesc: 'Payment confirmation is pending' });
        }
      } else {
        await db.failPayment(
          checkoutRequestId,
          queryCode,
          verification.data.ResultDesc || callback.ResultDesc || 'Payment failed',
          req.body
        );
      }

      return accepted(res);
    } catch (error) {
      return res.status(500).json({ ResultCode: 1, ResultDesc: 'Callback processing failed' });
    }
  };
}

module.exports = createCallbackHandler();
module.exports.createCallbackHandler = createCallbackHandler;
