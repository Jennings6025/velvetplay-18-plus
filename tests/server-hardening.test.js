
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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

test('rejects invalid JSON with HTTP 400', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(
      `${baseUrl}/api/payments/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"invalid":'
      }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Invalid request'
    });
  });
});

test('rejects request bodies larger than 1 MB with HTTP 413', async () => {
  await withServer(async baseUrl => {
    const oversizedBody = JSON.stringify({
      data: 'x'.repeat(1024 * 1024)
    });

    const response = await fetch(
      `${baseUrl}/api/payments/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedBody
      }
    );

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: 'Request body too large'
    });
  });
});

test('blocks symbolic links pointing outside the public directory', async () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const outsideDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'velvetplay-test-')
  );

  const linkName = `security-test-${process.pid}-${Date.now()}.txt`;
  const linkPath = path.join(publicDir, linkName);
  const outsideFile = path.join(outsideDir, 'outside.txt');

  try {
    await fs.writeFile(outsideFile, 'private test content');
    await fs.symlink(outsideFile, linkPath);

    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/${linkName}`);

      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'Forbidden');
    });
  } finally {
    await fs.rm(linkPath, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('continues serving the normal homepage', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') || '',
      /text\/html/
    );
  });
});
