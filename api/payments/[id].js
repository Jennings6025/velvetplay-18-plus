const { kv } = require("../../lib/kv");
const { queryStkPush, creditUserMinutes } = require("../../lib/daraja");

module.exports = async (req, res) => {
  try {
    const paymentId = req.query.id;

    if (!paymentId) {
      return res.status(400).json({ error: "Payment ID is required" });
    }

    const payment = await kv.get(`payment:${paymentId}`);

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    const sessionId = (req.cookies || {}).vp_session;

    if (payment.session_id !== sessionId) {
      return res.status(403).json({
        error: "Payment does not belong to this session"
      });
    }

    if (payment.status === "pending" && payment.checkout_request_id) {
      const query = await queryStkPush({
        checkoutRequestId: payment.checkout_request_id,
        env: process.env.MPESA_ENVIRONMENT || "sandbox"
      });

      const code = Number(query?.data?.ResultCode);
      const isPaid = query?.ok && code === 0;

      if (isPaid && payment.status !== "paid") {
        payment.status = "paid";
        payment.checked_at = new Date().toISOString();
        await kv.set(`payment:${paymentId}`, payment);
        await creditUserMinutes(payment.session_id, payment.minutes, paymentId, {
          amount: payment.amount,
          reference: payment.checkout_request_id
        });
      } else if (query?.ok && code !== 0 && payment.status === "pending") {
        payment.status = "failed";
        payment.result_desc = query?.data?.ResultDesc || "Payment failed";
        payment.checked_at = new Date().toISOString();
        await kv.set(`payment:${paymentId}`, payment);
      }
    }

    return res.status(200).json({
      payment_id: payment.payment_id,
      status: payment.status,
      amount: payment.amount,
      minutes: payment.minutes
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not check payment" });
  }
};