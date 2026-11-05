const crypto = require("crypto");
const { ensureProfile, createUserSession, getProfileBySession } = require("../lib/supabase");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const cookies = req.cookies || {};
    let sessionId = cookies.vp_session;

    if (sessionId) {
      const existing = await getProfileBySession(sessionId);
      if (existing) {
        await createUserSession(sessionId, existing.id || sessionId);
        return res.status(200).json({
          session_id: sessionId,
          minutes_balance: Number(existing.minutes_balance || 0),
          name: existing.name || "Guest Member"
        });
      }
    }

    sessionId = crypto.randomUUID();
    const user = await ensureProfile(sessionId, "Guest Member");
    await createUserSession(sessionId, user.id || sessionId);

    res.setHeader(
      "Set-Cookie",
      `vp_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
    );

    return res.status(200).json({
      session_id: sessionId,
      minutes_balance: Number(user.minutes_balance || 0),
      name: user.name || "Guest Member"
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not create session" });
  }
};