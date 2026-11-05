const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeKenyanPhone, isValidKenyanPhone } = require('../lib/phone');

test('normalizes Kenyan numbers from local and international formats', () => {
  assert.equal(normalizeKenyanPhone('0712345678'), '254712345678');
  assert.equal(normalizeKenyanPhone('254712345678'), '254712345678');
  assert.equal(normalizeKenyanPhone('+254712345678'), '254712345678');
});

test('accepts valid Safaricom numbers and rejects invalid ones', () => {
  assert.equal(isValidKenyanPhone('0712345678'), true);
  assert.equal(isValidKenyanPhone('254712345678'), true);
  assert.equal(isValidKenyanPhone('071234567'), false);
  assert.equal(isValidKenyanPhone('9999999999'), false);
  assert.equal(isValidKenyanPhone('abc'), false);
});
