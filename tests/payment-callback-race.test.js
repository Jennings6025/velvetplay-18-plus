
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCallbackHandler
} = require('../api/payments/callback');

const payment = {
  id: 'payment-uuid',
  member_id: 'member-uuid',
  amount_kes: 100,
  minutes: 35,
  seconds_credited: 2100,
  phone_number: '254712345678',
  status: 'paid',
  checkout_request_id: 'ws_CO_123'
};

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

function makeCallback() {
  return {
    method: 'POST',
    body: {
      Body: {
        stkCallback: {
          CheckoutRequestID: payment.checkout_request_id,
          ResultCode: 0,
          ResultDesc: 'Payment successful',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'QAZ123XYZ' },
              { Name: 'PhoneNumber', Value: 254712345678 }
            ]
          }
        }
      }
    }
  };
}

test('late receipt updates an already-paid payment without a second wallet credit', async () => {
  let confirmationCalls = 0;
  let failureCalls = 0;
  let confirmationArguments;

  const db = {
    getPaymentByCheckoutRequestId: async () => payment,
    confirmPayment: async (...args) => {
      confirmationCalls += 1;
      confirmationArguments = args;
      return { status: 'paid', duplicate: true };
    },
    failPayment: async () => {
      failureCalls += 1;
      return { status: 'failed' };
    }
  };

  const handler = createCallbackHandler({
    db,
    query: async ({ checkoutRequestId }) => ({
      ok: true,
      data: {
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: 'Payment successful'
      }
    })
  });

  const res = makeResponse();
  await handler(makeCallback(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(confirmationCalls, 1);
  assert.equal(failureCalls, 0);
  assert.equal(
    confirmationArguments[0],
    payment.checkout_request_id
  );
  assert.equal(confirmationArguments[1], 'QAZ123XYZ');
  assert.equal(confirmationArguments[3].Body.stkCallback.ResultCode, 0);
});

test('temporary Safaricom result does not fail a pending payment', async () => {
  let confirmationCalls = 0;
  let failureCalls = 0;

  const db = {
    getPaymentByCheckoutRequestId: async () => ({
      ...payment,
      status: 'pending'
    }),
    confirmPayment: async () => {
      confirmationCalls += 1;
      return { status: 'paid' };
    },
    failPayment: async () => {
      failureCalls += 1;
      return { status: 'failed' };
    }
  };

  const handler = createCallbackHandler({
    db,
    query: async ({ checkoutRequestId }) => ({
      ok: true,
      data: {
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 1000,
        ResultDesc: 'Request still processing'
      }
    })
  });

  const res = makeResponse();
  await handler(makeCallback(), res);

  assert.equal(res.statusCode, 502);
  assert.equal(confirmationCalls, 0);
  assert.equal(failureCalls, 0);
});
