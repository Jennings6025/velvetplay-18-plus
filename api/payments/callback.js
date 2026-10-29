const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  try {
    const body = req.body || {};
    const callback = body.Body && body.Body.stkCallback;

    if (!callback || !callback.CheckoutRequestID) {
      return res.status(400).json({
        ResultCode: 1,
        ResultDesc: "Invalid callback"
      });
    }

    const paymentId = await kv.get(`checkout:${callback.CheckoutRequestID}`);

    if (!paymentId) {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const payment = await kv.get(`payment:${paymentId}`);

    if (!payment) {
      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const resultCode = Number(callback.ResultCode);
    const succeeded = resultCode === 0;

    if (succeeded && payment.status !== "paid") {
      const sessionId = payment.session_id;
      const user = await kv.get(`user:${sessionId}`);

      if (user) {
        user.minutes_balance =
          (user.minutes_balance || 0) + Number(payment.minutes || 0);

        await kv.set(`user:${sessionId}`, user);
      }

      payment.status = "paid";
      payment.completed_at = new Date().toISOString();
      await kv.set(`payment:${paymentId}`, payment);
    } else if (!succeeded && payment.status === "pending") {
      payment.status = "failed";
      payment.result_desc = callback.ResultDesc || "Payment failed";
      payment.completed_at = new Date().toISOString();
      await kv.set(`payment:${paymentId}`, payment);
    }

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  } catch (error) {
    return res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Callback processing failed"
    });
  }
};