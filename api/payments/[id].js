
const store = require('../../lib/supabase');
const {
  queryStkPush,
  isSuccessfulStkQuery
} = require('../../lib/daraja');

// Only these known result codes are treated as terminal failures.
// Unknown results remain pending until Safaricom can confirm them.
const TERMINAL_FAILURE_CODES = new Set([
  1,
  1001,
  1019,
  1032,
  1037,
  2001
]);

function queryMatchesPayment(verification, payment) {
  if (
    verification?.ok !== true ||
    verification?.data?.CheckoutRequestID !==
      payment.checkout_request_id
  ) {
    return false;
  }

  const returnedMerchantId =
    verification.data.MerchantRequestID;

  if (
    payment.merchant_request_id &&
    returnedMerchantId &&
    returnedMerchantId !== payment.merchant_request_id
  ) {
    return false;
  }

  return true;
}

function createPaymentStatusHandler({
  db = store,
  query = queryStkPush
} = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
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

      const paymentId = req.params?.id || req.query?.id;

      if (!paymentId) {
        return res.status(400).json({
          error: 'Payment ID is required'
        });
      }

      // Always restrict payment lookup to the authenticated member.
      const payment = await db.getPaymentForMember(
        paymentId,
        member.id
      );

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found'
        });
      }

      if (
        payment.status === 'pending' &&
        payment.checkout_request_id
      ) {
        let verification = null;

        // A temporary Safaricom/network error must not
        // change a pending payment into a failed payment.
        try {
          verification = await query({
            checkoutRequestId: payment.checkout_request_id
          });
        } catch (error) {
          console.error(
            'M-Pesa status query error:',
            error.message
          );
        }

        if (queryMatchesPayment(verification, payment)) {
          if (
            isSuccessfulStkQuery(
              verification,
              payment.checkout_request_id
            )
          ) {
            const result = await db.confirmPayment(
              payment.checkout_request_id,
              null,
              verification.data.ResultDesc ||
                'Payment confirmed by Safaricom STK Query',
              null
            );

            if (result?.status === 'paid') {
              payment.status = 'paid';
            }
          } else {
            const rawCode = verification.data.ResultCode;
            const resultCode = Number(rawCode);

            const isValidResultCode =
              rawCode !== null &&
              rawCode !== undefined &&
              Number.isInteger(resultCode);

            if (
              isValidResultCode &&
              TERMINAL_FAILURE_CODES.has(resultCode)
            ) {
              const result = await db.failPayment(
                payment.checkout_request_id,
                resultCode,
                verification.data.ResultDesc ||
                  'Safaricom confirmed payment failure',
                null
              );

              if (result?.status === 'failed') {
                payment.status = 'failed';
              }
            }
          }
        }
      }

      return res.status(200).json({
        payment_id: payment.id,
        status: payment.status,
        amount_kes: Number(payment.amount_kes),
        minutes: Number(payment.minutes)
      });

    } catch (error) {
      console.error(
        'Payment status handler error:',
        error.message
      );

      return res.status(500).json({
        error: 'Could not check payment'
      });
    }
  };
}

module.exports = createPaymentStatusHandler();
module.exports.createPaymentStatusHandler =
  createPaymentStatusHandler;
module.exports.TERMINAL_FAILURE_CODES =
  TERMINAL_FAILURE_CODES;
