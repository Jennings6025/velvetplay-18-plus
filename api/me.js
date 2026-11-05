const { getMemberBySessionToken } = require('../lib/supabase');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const member = await getMemberBySessionToken(req.cookies?.vp_session);
    const balanceSeconds = member ? Math.max(0, Number(member.balance_seconds) || 0) : 0;
    return res.status(200).json({
      balance_seconds: balanceSeconds,
      minutes_balance: Math.ceil(balanceSeconds / 60),
      name: 'Guest Member'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load account' });
  }
};
