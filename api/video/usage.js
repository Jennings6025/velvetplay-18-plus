const { getProfileBySession, applyVideoUsage, updateProfileBalance, asNumber } = require('../../lib/supabase');
const { kv } = require('../../lib/kv');

function getSessionId(req) {
  const cookies = req.cookies || {};
  return cookies.vp_session || null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const sessionId = getSessionId(req);
    if (!sessionId) {
      return res.status(401).json({ error: 'No active session' });
    }

    const body = req.body || {};
    const rawSeconds = Number(body.seconds || 0);
    const secondsUsed = Number.isFinite(rawSeconds) ? Math.max(0, rawSeconds) : 0;

    if (!body.creator || secondsUsed <= 0) {
      return res.status(200).json({ ok: true, deducted_minutes: 0, balance: 0 });
    }

    const profile = await getProfileBySession(sessionId);
    if (!profile) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const minutesToDeduct = Math.ceil(secondsUsed / 60);
    const currentBalance = asNumber(profile.minutes_balance, 0);
    const nextBalance = Math.max(0, currentBalance - minutesToDeduct);

    if (minutesToDeduct > 0) {
      await updateProfileBalance(sessionId, nextBalance);
    }

    const usageRecord = await applyVideoUsage(sessionId, body.creator, secondsUsed);
    const sessionKey = `video_usage:${sessionId}:${Date.now()}`;
    await kv.set(sessionKey, { creator: body.creator, seconds_used: secondsUsed, created_at: new Date().toISOString() });

    return res.status(200).json({
      ok: true,
      deducted_minutes: minutesToDeduct,
      balance: nextBalance,
      usage_id: usageRecord && usageRecord.id ? usageRecord.id : sessionKey
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not store viewing usage' });
  }
};
