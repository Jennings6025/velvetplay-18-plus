const { kv } = require("@vercel/kv");
const crypto = require("crypto");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const cookies = req.cookies || {};
    let sessionId = cookies.vp_session;

    if (sessionId) {
      const existing = await kv.get(`user:${sessionId}`);

      if (existing) {
        return res.status(200).json({
          session_id: sessionId,
          minutes_balance: existing.minutes_balance || 0
        });
      }
    }

    sessionId = crypto.randomUUID();

    const user = {
      created_at: new Date().toISOString(),
      minutes_balance: 0,
      name: "Guest Member"
    };

    await kv.set(`user:${sessionId}`, user);

    res.setHeader(
      "Set-Cookie",
      `vp_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
    );

    return res.status(200).json({
      session_id: sessionId,
      minutes_balance: user.minutes_balance
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not create session" });
  }
};