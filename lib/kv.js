const memory = new Map();

function clone(value) {
  if (typeof value === 'undefined') return undefined;
  return JSON.parse(JSON.stringify(value));
}

const kv = {
  async get(key) {
    const value = memory.get(key);
    if (typeof value === 'undefined') return null;
    return clone(value);
  },
  async set(key, value) {
    memory.set(key, clone(value));
    return true;
  },
  async del(key) {
    memory.delete(key);
    return true;
  }
};

try {
  const vercelKv = require('@vercel/kv');
  const hasEnv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  if (vercelKv && hasEnv) {
    module.exports = vercelKv;
    return;
  }
} catch (error) {
  // Intentionally fall back to the in-memory store when the Vercel KV
  // credentials are not configured, which is common in local development.
}

module.exports = { kv };
