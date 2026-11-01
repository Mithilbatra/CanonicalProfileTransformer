'use strict';

process.env.DB_PATH = ':memory:';
process.env.SILENCE_MAIL = '1';
process.env.SILENCE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const app = require('../server/index');

test('unknown API routes answer with a JSON 404, never the app page', async () => {
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/no-such-route`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  } finally {
    server.close();
  }
});
