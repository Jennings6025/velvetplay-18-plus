const { getProfileBySession } = require("../lib/supabase");

function getSessionId(req) {
  const cookies = req.cookies || {};
  return cookies.vp_session || null;
}

module.exports = async (req, res) => {
  try {
    const sessionId = getSessionId(req);

    if (!sessionId) {
      return res.status(200).json({
        minutes_balance: 0,
        name: "Guest Member"
      });
    }

    const user = await getProfileBySession(sessionId);

    if (!user) {
      return res.status(200).json({
        minutes_balance: 0,
        name: "Guest Member"
      });
    }

    return res.status(200).json({
      minutes_balance: Number(user.minutes_balance || 0),
      name: user.name || "Guest Member",
      session_id: sessionId
    });
  } catch (error) {
    return res.status(500).json({ error: "Could not load account" });
  }
};