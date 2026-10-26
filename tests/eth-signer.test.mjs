import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DirectSecp256k1HdWallet, makeSignBytes } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { Secp256k1, Secp256k1Signature, keccak256 } from '@cosmjs/crypto';
import { fromBase64 } from '@cosmjs/encoding';
import { Wallet } from '@ethersproject/wallet';
import Long from 'long';
import EthSigner from '../src/utils/EthSigner.mjs';
import { uint64 } from '../src/utils/Uint64.mjs';

// BIP-39 public test vector. Never use this mnemonic for real funds.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('Ethermint wrapper exposes the address of its actual key and refuses another operator', async () => {
  const base = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix: 'epix', hdPaths: [stringToPath("m/44'/60'/0'/0/0")],
  });
  const signer = EthSigner(base, Wallet.fromMnemonic(MNEMONIC), 'epix');
  const [cosmos] = await base.getAccounts();
  const [account] = await signer.getAccounts();
  assert.notEqual(cosmos.address, account.address);
  assert.equal(account.address, await signer.getAddress());
  assert.deepEqual(account.pubkey, cosmos.pubkey);
  const doc = { bodyBytes: new Uint8Array(), authInfoBytes: new Uint8Array(),
    chainId: 'offline-eth-fixture', accountNumber: uint64('18446744073709551615') };
  await assert.rejects(signer.signDirect(cosmos.address, doc), /not available from Ethermint signer/);
  const signed = await signer.signDirect(account.address, doc);
  assert.equal(await Secp256k1.verifySignature(
    Secp256k1Signature.fromFixedLength(fromBase64(signed.signature.signature)),
    keccak256(makeSignBytes(doc)), account.pubkey), true);
});

test('Ethermint wrapper rejects a mismatched underlying key', async () => {
  const base = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
    prefix: 'epix', hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
  });
  const signer = EthSigner(base, Wallet.fromMnemonic(MNEMONIC), 'epix');
  await assert.rejects(signer.getAccounts(), /public key does not match/);
  await assert.rejects(signer.signDirect(await signer.getAddress(), {}), /public key does not match/);
});

test('uint64 helper preserves unsigned Long values and rejects negative signed Longs', () => {
  for (const value of ['0', '9007199254740993', '9223372036854775808', '18446744073709551615']) {
    const actual = uint64(Long.fromString(value, true));
    assert.equal(actual.toString(), value);
    assert.equal(actual.unsigned, true);
  }
  assert.throws(() => uint64(Long.fromInt(-1)), /uint64/i);
});
