const crypto = require('crypto');
const store = require('../../lib/supabase');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createVideoUsageHandler({ db = store } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const member = await db.getMemberBySessionToken(req.cookies?.vp_session);
      if (!member) return res.status(401).json({ error: 'No active session' });

      const body = req.body || {};
      if (body.action === 'start') {
        const creatorName = typeof body.creator === 'string' ? body.creator.trim().slice(0, 80) : '';
        if (!creatorName) return res.status(400).json({ error: 'Creator is required' });

        const videoSessionId = crypto.randomUUID();
        const result = await db.startVideoSession(member.id, videoSessionId, creatorName);
        return res.status(200).json({ ok: true, ...result });
      }

      if (!UUID_PATTERN.test(String(body.video_session_id || ''))) {
        return res.status(400).json({ error: 'Invalid video session' });
      }

      if (body.action === 'usage') {
        const seconds = Number(body.seconds);
        const idempotencyKey = String(body.idempotency_key || '');
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 15 || !UUID_PATTERN.test(idempotencyKey)) {
          return res.status(400).json({ error: 'Invalid usage event' });
        }
        const result = await db.recordVideoUsage(
          member.id,
          body.video_session_id,
          seconds,
          idempotencyKey
        );
        return res.status(200).json({ ok: true, ...result });
      }

      if (['pause', 'resume', 'stop'].includes(body.action)) {
        const result = await db.setVideoSessionState(
          member.id,
          body.video_session_id,
          body.action
        );
        return res.status(200).json({ ok: true, ...result });
      }

      return res.status(400).json({ error: 'Invalid video action' });
    } catch (error) {
      return res.status(409).json({ error: 'Video session could not be updated' });
    }
  };
}

module.exports = createVideoUsageHandler();
module.exports.createVideoUsageHandler = createVideoUsageHandler;
