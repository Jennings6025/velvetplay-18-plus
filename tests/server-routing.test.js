
const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server');

async function withServer(run) {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('payment callback uses the fixed callback handler', async () => {
  const callbackPath = require.resolve('../api/payments/callback.js');
  const previous = require.cache[callbackPath];
  let called = false;

  require.cache[callbackPath] = {
    id: callbackPath,
    filename: callbackPath,
    loaded: true,
    exports: async (_req, res) => {
      called = true;
      res.status(202).json({ route: 'callback' });
    }
  };

  try {
    await withServer(async baseUrl => {
      const response = await fetch(
        `${baseUrl}/api/payments/callback`,
        { method: 'POST' }
      );

      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), {
        route: 'callback'
      });
      assert.equal(called, true);
    });
  } finally {
    if (previous) {
      require.cache[callbackPath] = previous;
    } else {
      delete require.cache[callbackPath];
    }
  }
});

test('static file serving rejects path traversal', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(
      `${baseUrl}/..%2f..%2fetc/passwd`,
      { redirect: 'manual' }
    );

    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Forbidden');
  });
});
