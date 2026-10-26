import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { DirectSecp256k1Wallet, makeSignBytes } from '@cosmjs/proto-signing';
import { fromBase64 } from '@cosmjs/encoding';
import { Secp256k1, Secp256k1Signature, keccak256, sha256 } from '@cosmjs/crypto';
import { Wallet as EthereumWallet } from '@ethersproject/wallet';
import { AuthInfo, SignDoc, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx.js';
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx.js';
import SigningClient from '../src/utils/SigningClient.mjs';
import EthSigner from '../src/utils/EthSigner.mjs';

const ADDRESS = 'epix10e0525sfrf53yh2aljmm3sn9jq5njk7l3tzn82';
const KEY_TYPE = '/ethermint.crypto.v1.ethsecp256k1.PubKey';
const PUBKEY = Uint8Array.from(Buffer.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));
const STOP = new Error('Stopped before broadcast');
const boundaries = ['0', '1', '9007199254740991', '9007199254740992', '9007199254740993',
  '9223372036854775807', '9223372036854775808', '9223372036854775809', '18446744073709551615'];

function messages() {
  return [{ typeUrl: '/cosmos.authz.v1beta1.MsgExec', value: {
    grantee: ADDRESS,
    msgs: [{ typeUrl: '/cosmos.staking.v1beta1.MsgDelegate', value: MsgDelegate.encode(
      MsgDelegate.fromPartial({ delegatorAddress: 'granter', validatorAddress: 'validator',
        amount: { denom: 'aepix', amount: '9007199254740993' } })).finish() }],
  } }];
}

async function fixture(t, options = {}) {
  const address = options.address || ADDRESS;
  const captured = { signCalls: 0, posts: [] };
  const account = { address, pub_key: { '@type': options.keyType || KEY_TYPE },
    account_number: Object.hasOwn(options, 'accountNumber') ? options.accountNumber : '1',
    sequence: Object.hasOwn(options, 'sequence') ? options.sequence : '0' };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/cosmos/auth/v1beta1/accounts/' + address) {
      response.end(JSON.stringify({ account: options.wrap ? options.wrap(account) : account }));
      return;
    }
    if (request.method === 'POST' && request.url === '/cosmos/tx/v1beta1/simulate') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const tx = TxRaw.decode(fromBase64(JSON.parse(body).tx_bytes));
      captured.posts.push({ body: TxBody.decode(tx.bodyBytes), auth: AuthInfo.decode(tx.authInfoBytes) });
      response.end(JSON.stringify({ gas_info: { gas_used: options.gasUsed ?? '101' } }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ error: 'Unexpected request, no broadcast is allowed' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const network = { restUrl: `http://127.0.0.1:${server.address().port}`,
    chainId: 'epix-offline-fixture', slip44: 60, gasPrice: '0.1aepix', gasModifier: 1.5 };
  const signer = {
    getAccounts: async () => options.signerAccounts || [{ address, pubkey: PUBKEY }],
    signDirect: async (address, signDoc) => {
      captured.signCalls++;
      captured.address = address;
      captured.originalSignDoc = signDoc;
      captured.signBytes = makeSignBytes(signDoc);
      captured.signDoc = SignDoc.decode(captured.signBytes);
      captured.auth = AuthInfo.decode(signDoc.authInfoBytes);
      captured.body = TxBody.decode(signDoc.bodyBytes);
      if (options.signDirect) captured.signature = await options.signDirect(address, signDoc);
      throw STOP;
    },
  };
  const client = SigningClient(network, signer);
  client.registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec);
  return { client, captured };
}

test('locked protobuf signing preserves every uint64 account and sequence bit', async t => {
  for (const value of boundaries) {
    await t.test(value, async t => {
      const { client, captured } = await fixture(t, { accountNumber: value, sequence: value });
      await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000', 'fixture'), error => error === STOP);
      assert.equal(captured.signDoc.accountNumber.toString(), value);
      assert.equal(captured.auth.signerInfos[0].sequence.toString(), value);
      assert.equal(captured.originalSignDoc.accountNumber.unsigned, true);
      assert.equal(captured.auth.signerInfos[0].publicKey.typeUrl, KEY_TYPE);
      assert.equal(captured.auth.fee.gasLimit.toString(), '200000');
      assert.equal(captured.auth.fee.amount[0].amount, '20000');
      const exec = MsgExec.decode(captured.body.messages[0].value);
      assert.equal(MsgDelegate.decode(exec.msgs[0].value).amount.amount, '9007199254740993');
    });
  }
});

test('base, vesting and nested account responses preserve uint64 strings', async t => {
  const forms = [a => a, a => ({ base_account: a }),
    a => ({ base_vesting_account: { base_account: a } }), a => ({ account: a })];
  for (const [index, wrap] of forms.entries()) {
    await t.test(String(index), async t => {
      const { client, captured } = await fixture(t, { wrap,
        accountNumber: '14353137888589996058', sequence: '9007199254740993' });
      await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000', 'fixture'), error => error === STOP);
      assert.equal(captured.signDoc.accountNumber.toString(), '14353137888589996058');
      assert.equal(captured.auth.signerInfos[0].sequence.toString(), '9007199254740993');
    });
  }
});

test('unsafe or malformed account and sequence values fail before signing', async t => {
  const invalid = [-1, 1.5, 9007199254740992, '', '-1', '1.5', '1e3', '01',
    '18446744073709551616', null, {}, true];
  for (const field of ['accountNumber', 'sequence']) {
    for (const value of invalid) {
      await t.test(`${field}=${JSON.stringify(value)}`, async t => {
        const { client, captured } = await fixture(t, { [field]: value });
        await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000', 'fixture'), /uint64/i);
        assert.equal(captured.signCalls, 0);
      });
    }
  }
});

test('legacy safe numeric account values and zero sequence remain supported', async t => {
  const { client, captured } = await fixture(t, { accountNumber: 34391, sequence: 0 });
  await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), 200000, 'fixture'), error => error === STOP);
  assert.equal(captured.signDoc.accountNumber.toString(), '34391');
  assert.equal(captured.auth.signerInfos[0].sequence.toString(), '0');
});

test('fee and simulation assembly preserve integer gas and sequence', async t => {
  for (const value of boundaries) {
    await t.test(value, async t => {
      const { client, captured } = await fixture(t, { sequence: value, gasUsed: value });
      const gas = await client.simulate(ADDRESS, messages(), 'fixture', 1);
      assert.equal(gas, value);
      assert.equal(captured.posts[0].auth.signerInfos[0].sequence.toString(), value);
      const fee = client.getFee(value);
      assert.equal(fee.gas, value);
      assert.equal(fee.amount[0].amount, ((BigInt(value) + 9n) / 10n).toString());
    });
  }
});

test('simulation gas margin rounds up without converting through Number', async t => {
  const { client } = await fixture(t, { gasUsed: '101' });
  assert.equal(await client.simulate(ADDRESS, messages(), 'fixture', '1.1'), '112');
});

test('invalid gas, simulated gas or multiplier fails closed', async t => {
  const { client } = await fixture(t);
  for (const value of [-1, 9007199254740992, '-1', '1.5', '1e3', '18446744073709551616']) {
    assert.throws(() => client.getFee(value), /uint64/i);
    await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), value), /uint64/i);
  }
  for (const value of ['-1', '1.5', '18446744073709551616']) {
    const { client: badSimulation } = await fixture(t, { gasUsed: value });
    await assert.rejects(badSimulation.simulate(ADDRESS, messages(), 'fixture', 1), /uint64/i);
  }
  for (const multiplier of [0, -1, Infinity, NaN, 'bad']) {
    await assert.rejects(client.simulate(ADDRESS, messages(), 'fixture', multiplier), /gas modifier/i);
  }
  const { client: overflowing } = await fixture(t, { gasUsed: '18446744073709551615' });
  await assert.rejects(overflowing.simulate(ADDRESS, messages(), 'fixture', 2), /uint64/i);
});

test('signing and simulation reject an unavailable account before signing or posting', async t => {
  const { client, captured } = await fixture(t, { signerAccounts: [{ address: 'other', pubkey: PUBKEY }] });
  await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000'), /not available from signer/);
  await assert.rejects(client.simulate(ADDRESS, messages()), /not available from signer/);
  assert.equal(captured.signCalls, 0);
  assert.equal(captured.posts.length, 0);
});

test('selects the requested account instead of the first signer public key', async t => {
  const { client, captured } = await fixture(t, { signerAccounts: [
    { address: 'other', pubkey: new Uint8Array(33) }, { address: ADDRESS, pubkey: PUBKEY },
  ] });
  await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000'), error => error === STOP);
  assert.equal(captured.address, ADDRESS);
  assert.equal(Buffer.from(captured.auth.signerInfos[0].publicKey.value).subarray(2).toString('hex'),
    Buffer.from(PUBKEY).toString('hex'));
});

test('standard Cosmos direct signer preserves unsigned account numbers', async t => {
  const key = new Uint8Array(32);
  key[31] = 1;
  const signer = await DirectSecp256k1Wallet.fromKey(key, 'epix');
  const [account] = await signer.getAccounts();
  const { client, captured } = await fixture(t, { address: account.address,
    keyType: '/cosmos.crypto.secp256k1.PubKey', accountNumber: '18446744073709551615',
    sequence: '9223372036854775808', signDirect: signer.signDirect.bind(signer) });
  await assert.rejects(client.signAndBroadcast(account.address, messages(), '200000'), error => error === STOP);
  assert.equal(captured.signDoc.accountNumber.toString(), '18446744073709551615');
  const signature = fromBase64(captured.signature.signature.signature);
  assert.equal(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature),
    sha256(captured.signBytes), account.pubkey), true);
});

test('Ethermint signing verifies the exact high account and sequence wire bytes', async t => {
  // Public scalar1 is only a disposable test key, never a funded live wallet.
  const ethWallet = new EthereumWallet('0x' + '1'.padStart(64, '0'));
  const ethSigner = EthSigner({ getAccounts: async () => [{ pubkey: PUBKEY }] }, ethWallet, 'epix');
  const { client, captured } = await fixture(t, { accountNumber: '14353137888589996058',
    sequence: '9007199254740993', signDirect: ethSigner.signDirect });
  await assert.rejects(client.signAndBroadcast(ADDRESS, messages(), '200000', 'fixture'), error => error === STOP);
  assert.equal(captured.signDoc.accountNumber.toString(), '14353137888589996058');
  const signature = fromBase64(captured.signature.signature.signature);
  assert.equal(signature.length, 64);
  assert.equal(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature),
    keccak256(captured.signBytes), PUBKEY), true);
  const rounded = SignDoc.fromPartial({ ...captured.signDoc,
    accountNumber: '14353137888589996032' });
  assert.equal(await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature),
    keccak256(SignDoc.encode(rounded).finish()), PUBKEY), false);
});
