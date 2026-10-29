const { kv } = require("@vercel/kv");

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