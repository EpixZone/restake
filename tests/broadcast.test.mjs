import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import SigningClient from '../src/utils/SigningClient.mjs';

const ADDRESS = 'cosmos1offlinefixture';
const HASH = 'A'.repeat(64);

async function fixture(t, options = {}) {
  const captured = { broadcasts: 0, polls: 0, timers: [], cleared: [] };
  const txTimeout = options.missing ? 10 : 123456;
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  // Exercise the real timeout/poll code without a three-second wait per case.
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const handle = setTimer(fn, ms === 3000 ? 1 : ms, ...args);
    if (ms === txTimeout) captured.timers.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (captured.timers.includes(handle)) captured.cleared.push(handle);
    clearTimer(handle);
  });
  t.after(() => captured.timers.forEach(clearTimer));
  const responseTx = (code, height) => ({ code, height, txhash: HASH,
    raw_log: code ? 'Fixture transaction rejected' : '', gas_used: '100', gas_wanted: '200000' });
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url.includes('/accounts/')) {
      response.end(JSON.stringify({ account: { address: ADDRESS, account_number: '1', sequence: '0' } }));
    } else if (request.method === 'POST' && request.url === '/cosmos/tx/v1beta1/txs') {
      for await (const ignored of request) { /* Drain the actual signed request. */ }
      captured.broadcasts++;
      response.statusCode = options.postError ? 503 : 200;
      response.end(JSON.stringify(options.postError ? { message: 'Service unavailable' } :
        { tx_response: responseTx(options.checkCode || 0, '0') }));
    } else if (request.method === 'GET' && request.url === '/cosmos/tx/v1beta1/txs/' + HASH) {
      captured.polls++;
      response.statusCode = options.missing ? 404 : 200;
      response.end(JSON.stringify(options.missing ? { message: 'Not indexed' } :
        { tx_response: responseTx(options.commitCode || 0, '123') }));
    } else {
      response.statusCode = 500;
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const signer = {
    getAccounts: async () => [{ address: ADDRESS, pubkey: new Uint8Array(33) }],
    signDirect: async (address, signed) => ({ signed, signature: { signature: Buffer.alloc(64).toString('base64') } }),
  };
  const client = SigningClient({ restUrl: `http://127.0.0.1:${server.address().port}`,
    chainId: 'offline-broadcast-fixture', gasPrice: '0.1uatom', txTimeout }, signer);
  return { captured, send: () => client.signAndBroadcast(ADDRESS, [], '200000', 'fixture') };
}

function assertClean(captured) {
  assert.equal(captured.broadcasts, 1, 'never resubmit a rejected or unknown transaction');
  assert.equal(captured.timers.length, 1);
  assert.deepEqual(captured.cleared, captured.timers, 'release timeout on every completion path');
}

test('initial broadcast HTTP failure rejects and releases its timer', async t => {
  const { send, captured } = await fixture(t, { postError: true });
  await assert.rejects(send(), /503/);
  assert.equal(captured.polls, 0);
  assertClean(captured);
});

test('CheckTx rejection rejects and releases its timer without polling', async t => {
  const { send, captured } = await fixture(t, { checkCode: 4 });
  await assert.rejects(send(), /Fixture transaction rejected/);
  assert.equal(captured.polls, 0);
  assertClean(captured);
});

test('committed transaction failure rejects instead of reporting success', async t => {
  const { send, captured } = await fixture(t, { commitCode: 5 });
  await assert.rejects(send(), /Fixture transaction rejected/);
  assert.equal(captured.polls, 1);
  assertClean(captured);
});

test('unknown submission at timeout rejects and is never resubmitted', async t => {
  const { send, captured } = await fixture(t, { missing: true });
  await assert.rejects(send(), /was submitted but was not yet found/);
  assertClean(captured);
});

test('only a committed successful response resolves', async t => {
  const { send, captured } = await fixture(t);
  const result = await send();
  assert.equal(result.code, 0);
  assert.equal(result.height, '123');
  assert.equal(result.transactionHash, HASH);
  assert.equal(captured.polls, 1);
  assertClean(captured);
});
