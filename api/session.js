const crypto = require('crypto');
const { getMemberBySessionToken, createMemberSession } = require('../lib/supabase');

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sessionResponse(member) {
  const balanceSeconds = Math.max(0, Number(member.balance_seconds) || 0);
  return {
    balance_seconds: balanceSeconds,
    minutes_balance: Math.ceil(balanceSeconds / 60),
    name: 'Guest Member'
  };
}

function cookieOptions(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = process.env.NODE_ENV === 'production' || forwardedProto === 'https';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function createSessionHandler({ db = { getMemberBySessionToken, createMemberSession } } = {}) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const token = req.cookies?.vp_session;
      if (token) {
        const existing = await db.getMemberBySessionToken(token);
        if (existing) return res.status(200).json(sessionResponse(existing));
      }

      const newToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
      const member = await db.createMemberSession(newToken, expiresAt);
      res.setHeader('Set-Cookie', `vp_session=${newToken}; ${cookieOptions(req)}`);
      return res.status(200).json(sessionResponse(member));
    } catch (error) {
      return res.status(500).json({ error: 'Could not create session' });
    }
  };
}

module.exports = createSessionHandler();
module.exports.createSessionHandler = createSessionHandler;
