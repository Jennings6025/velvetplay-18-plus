const { createClient } = require('@supabase/supabase-js');
const { kv } = require('./kv');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_SECRET ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !serviceRoleKey) return null;

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function asNumber(value, fallback = 0) {
  const numericValue = Number(value ?? fallback);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

async function getProfileBySession(sessionId) {
  if (!sessionId) return null;

  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client
      .from('profiles')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (data) return data;
  }

  return (await kv.get(`user:${sessionId}`)) || null;
}

async function ensureProfile(sessionId, preferredName = 'Guest Member') {
  if (!sessionId) return null;

  const client = getSupabaseClient();
  if (client) {
    const existing = await getProfileBySession(sessionId);
    if (existing) return existing;

    const payload = {
      session_id: sessionId,
      name: preferredName,
      minutes_balance: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await client
      .from('profiles')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  const user = (await kv.get(`user:${sessionId}`)) || {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    minutes_balance: 0,
    name: preferredName
  };

  user.name = user.name || preferredName;
  user.minutes_balance = asNumber(user.minutes_balance, 0);
  await kv.set(`user:${sessionId}`, user);
  return user;
}

async function updateProfileBalance(sessionId, minutesBalance) {
  const profile = await ensureProfile(sessionId, 'Guest Member');
  if (!profile) return null;

  const numericBalance = asNumber(minutesBalance, 0);
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client
      .from('profiles')
      .update({
        minutes_balance: numericBalance,
        updated_at: new Date().toISOString()
      })
      .eq('session_id', sessionId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  const existing = await kv.get(`user:${sessionId}`);
  if (!existing) return null;
  existing.minutes_balance = numericBalance;
  await kv.set(`user:${sessionId}`, existing);
  return existing;
}

async function createUserSession(sessionId, profileId) {
  if (!sessionId) return null;

  const client = getSupabaseClient();
  if (client) {
    const payload = {
      session_id: sessionId,
      profile_id: profileId,
      last_seen_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    const { data, error } = await client
      .from('user_sessions')
      .upsert(payload, { onConflict: 'session_id' })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  return { session_id: sessionId, profile_id: profileId };
}

async function appendWalletLedger({
  sessionId,
  entryType,
  minutes,
  amount,
  paymentId,
  reference,
  metadata = {}
}) {
  const profile = await ensureProfile(sessionId, 'Guest Member');
  if (!profile) return null;

  const client = getSupabaseClient();
  const payload = {
    session_id: sessionId,
    profile_id: profile.id,
    entry_type: entryType,
    minutes: asNumber(minutes, 0),
    amount: asNumber(amount, 0),
    payment_id: paymentId || null,
    reference: reference || null,
    metadata: metadata || {},
    created_at: new Date().toISOString()
  };

  if (client) {
    const { data, error } = await client
      .from('vp_ledger')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  return payload;
}

async function applyWalletCredit(sessionId, minutes, paymentId = null, metadata = {}) {
  const profile = await getProfileBySession(sessionId);
  if (!profile) return null;

  const nextMinutes = asNumber(profile.minutes_balance, 0) + asNumber(minutes, 0);
  await updateProfileBalance(sessionId, nextMinutes);
  return appendWalletLedger({
    sessionId,
    entryType: 'payment_credit',
    minutes,
    amount: asNumber(metadata.amount || 0, 0),
    paymentId,
    reference: metadata.reference || paymentId || null,
    metadata
  });
}

async function applyVideoUsage(sessionId, creatorName, secondsUsed) {
  const profile = await getProfileBySession(sessionId);
  if (!profile) return null;

  const seconds = Math.max(0, Number(secondsUsed) || 0);
  const minutesToDeduct = Math.max(0, Math.ceil(seconds / 60));

  if (minutesToDeduct > 0) {
    const currentBalance = asNumber(profile.minutes_balance, 0);
    const nextBalance = Math.max(0, currentBalance - minutesToDeduct);
    await updateProfileBalance(sessionId, nextBalance);
    await appendWalletLedger({
      sessionId,
      entryType: 'video_usage',
      minutes: -minutesToDeduct,
      amount: 0,
      metadata: { creator_name: creatorName || 'Unknown creator', seconds_used: seconds }
    });
  }

  const client = getSupabaseClient();
  const payload = {
    session_id: sessionId,
    profile_id: profile.id,
    creator_name: creatorName || 'Unknown creator',
    seconds_used: seconds,
    minutes_used: minutesToDeduct,
    created_at: new Date().toISOString()
  };

  if (client) {
    const { data, error } = await client
      .from('paid_video_views')
      .insert(payload)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  return payload;
}

module.exports = {
  getSupabaseClient,
  getProfileBySession,
  ensureProfile,
  updateProfileBalance,
  createUserSession,
  appendWalletLedger,
  applyWalletCredit,
  applyVideoUsage,
  asNumber
};
