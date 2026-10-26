import _ from 'lodash'
import { bignumber } from 'mathjs'

import {
  defaultRegistryTypes as defaultStargateTypes,
  assertIsDeliverTxSuccess,
  GasPrice
} from "@cosmjs/stargate";
import { sleep } from "@cosmjs/utils";
import { Registry } from "@cosmjs/proto-signing";
import { toBase64, fromBase64 } from '@cosmjs/encoding'
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing.js";
import { AuthInfo, Fee, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { coin, get, post } from './Helpers.mjs'
import { uint64 } from './Uint64.mjs'

function SigningClient(network, signer) {

  const defaultGasPrice = network.gasPricePrefer || network.gasPrice
  const { restUrl, gasModifier: defaultGasModifier, slip44: coinType, chainId } = network

  const registry = new Registry(defaultStargateTypes);

  function getAccount(address) {
    return get(restUrl + "/cosmos/auth/v1beta1/accounts/" + address)
      .then((res) => res.data.account)
      .then((value) => {
        // see https://github.com/chainapsis/keplr-wallet/blob/7ca025d32db7873b7a870e69a4a42b525e379132/packages/cosmos/src/account/index.ts#L73
        // If the chain modifies the account type, handle the case where the account type embeds the base account.
        // (Actually, the only existent case is ethermint, and this is the line for handling ethermint)
        const baseAccount =
          value.BaseAccount || value.baseAccount || value.base_account;
        if (baseAccount) {
          value = baseAccount;
        }

        // If the account is the vesting account that embeds the base vesting account,
        // the actual base account exists under the base vesting account.
        // But, this can be different according to the version of cosmos-sdk.
        // So, anyway, try to parse it by some ways...
        const baseVestingAccount =
          value.BaseVestingAccount ||
          value.baseVestingAccount ||
          value.base_vesting_account;
        if (baseVestingAccount) {
          value = baseVestingAccount;

          const baseAccount =
            value.BaseAccount || value.baseAccount || value.base_account;
          if (baseAccount) {
            value = baseAccount;
          }
        }

        // Handle nested account like Desmos
        const nestedAccount = value.account
        if(nestedAccount){
          value = nestedAccount
        }

        return {
          ...value,
          account_number: uint64(value.account_number, 'account_number').toString(),
          sequence: uint64(value.sequence, 'sequence').toString(),
        }
      })
      .catch((error) => {
        if(error.response?.status === 404){
          throw new Error('Account does not exist on chain')
        }else{
          throw error
        }
      })
  };

  // vendored to handle large integers
  // https://github.com/cosmos/cosmjs/blob/0f0c9d8a754cbf01e17acf51d3f2dbdeaae60757/packages/stargate/src/fee.ts
  function calculateFee(gasLimit, gasPrice) {
    gasLimit = uint64(gasLimit, 'gas_limit').toString();
    const processedGasPrice = typeof gasPrice === "string" ? GasPrice.fromString(gasPrice) : gasPrice;
    const { denom, amount: gasPriceAmount } = processedGasPrice;
    const amount = bignumber(gasPriceAmount.toString()).mul(gasLimit).ceil();
    return {
      amount: [coin(amount, denom)],
      gas: gasLimit.toString()
    };
  }

  function getFee(gas, gasPrice) {
    if (gas === undefined)
      gas = 200000;
    return calculateFee(gas, gasPrice || defaultGasPrice);
  }

  async function signAndBroadcastWithoutBalanceCheck(address, msgs, gas, memo, gasPrice) {
    try {
      return await signAndBroadcast(address, msgs, gas, memo, gasPrice)
    } finally {
    }
  }

  async function signAndBroadcast(address, messages, gas, memo, gasPrice) {
    if (gas === undefined)
      gas = await simulate(address, messages, memo);
    const fee = getFee(gas, gasPrice);
    const txBody = await sign(address, messages, memo, fee)
    return broadcast(txBody)
  }

  async function broadcast(txBody){
    const timeoutMs = network.txTimeout || 60_000
    const pollIntervalMs = 3_000
    let timedOut = false
    const txPollTimeout = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    const pollForTx = async (txId) => {
      if (timedOut) {
        throw new Error(
          `Transaction with ID ${txId} was submitted but was not yet found on the chain. You might want to check later. There was a wait of ${timeoutMs / 1000} seconds.`
        );
      }
      await sleep(pollIntervalMs);
      try {
        const response = await get(restUrl + '/cosmos/tx/v1beta1/txs/' + txId);
        const result = parseTxResult(response.data.tx_response)
        return result
      } catch {
        return pollForTx(txId);
      }
    };

    try {
      const response = await post(restUrl + '/cosmos/tx/v1beta1/txs', {
        tx_bytes: toBase64(TxRaw.encode(txBody).finish()),
        mode: "BROADCAST_MODE_SYNC"
      })
      const result = parseTxResult(response.data.tx_response)
      assertIsDeliverTxSuccess(result)
      const committed = await pollForTx(result.transactionHash)
      assertIsDeliverTxSuccess(committed)
      return committed
    } finally {
      clearTimeout(txPollTimeout);
    }
  }

  async function sign(address, messages, memo, fee){
    const account = await getAccount(address)
    const { account_number: accountNumber, sequence } = account
    const txBodyBytes = makeBodyBytes(messages, memo)
    // Sign using standard protobuf messages
    const authInfoBytes = await makeAuthInfoBytes(address, account, {
      amount: fee.amount,
      gasLimit: fee.gas,
    }, SignMode.SIGN_MODE_DIRECT)
    const signDoc = {
      bodyBytes: txBodyBytes,
      authInfoBytes,
      chainId,
      accountNumber: uint64(accountNumber, 'account_number'),
    };
    const { signature, signed } = await signer.signDirect(address, signDoc);
    return {
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    }
  }

  async function simulate(address, messages, memo, modifier) {
    let gasModifier
    try {
      const value = modifier ?? defaultGasModifier
      if (!['number', 'string'].includes(typeof value)) throw new Error()
      gasModifier = bignumber(value.toString())
      if (!gasModifier.isFinite() || gasModifier.lte(0)) throw new Error()
    } catch {
      throw new Error('Invalid gas modifier')
    }
    const account = await getAccount(address)
    const fee = getFee(100_000)
    const txBody = {
      bodyBytes: makeBodyBytes(messages, memo),
      authInfoBytes: await makeAuthInfoBytes(address, account, {
        amount: fee.amount,
        gasLimit: fee.gas,
      }, SignMode.SIGN_MODE_UNSPECIFIED),
      signatures: [new Uint8Array()],
    }

    try {
      const estimate = await post(restUrl + '/cosmos/tx/v1beta1/simulate', {
        tx_bytes: toBase64(TxRaw.encode(txBody).finish()),
      }).then(el => el.data.gas_info.gas_used)
      const gasUsed = uint64(estimate, 'simulated gas').toString()
      const gasLimit = bignumber(gasUsed).mul(gasModifier).ceil()
      if (gasLimit.gt('18446744073709551615')) throw new Error('Invalid uint64 gas_limit')
      return uint64(gasLimit.toFixed(0), 'gas_limit').toString()
    } catch (error) {
      throw new Error(error.response?.data?.message || error.message)
    }
  }

  function parseTxResult(result){
    return {
      code: result.code,
      height: result.height,
      rawLog: result.raw_log,
      transactionHash: result.txhash,
      gasUsed: result.gas_used,
      gasWanted: result.gas_wanted,
    }
  }

  function makeBodyBytes(messages, memo){
    const anyMsgs = messages.map((m) => registry.encodeAsAny(m));
    return TxBody.encode(
      TxBody.fromPartial({
        messages: anyMsgs,
        memo: memo,
      })
    ).finish()
  }

  async function makeAuthInfoBytes(address, account, fee, mode){
    const { sequence } = account
    const accountFromSigner = (await signer.getAccounts()).find(account => account.address === address)
    if (!accountFromSigner) {
      throw new Error("Requested account is not available from signer");
    }
    const signerPubkey = accountFromSigner.pubkey;
    return AuthInfo.encode({
      signerInfos: [
        {
          publicKey: {
            typeUrl: pubkeyTypeUrl(account.pub_key),
            value: PubKey.encode({
              key: signerPubkey,
            }).finish(),
          },
          sequence: uint64(sequence, 'sequence'),
          modeInfo: { single: { mode: mode } },
        },
      ],
      fee: Fee.fromPartial({ ...fee, gasLimit: uint64(fee.gasLimit, 'gas_limit') }),
    }).finish()
  }

  function pubkeyTypeUrl(pub_key){
    if(pub_key && pub_key['@type']) return pub_key['@type']

    if(network.path === 'injective'){
      return '/injective.crypto.v1beta1.ethsecp256k1.PubKey'
    }

    if(coinType === 60){
      return '/ethermint.crypto.v1.ethsecp256k1.PubKey'
    }
    return '/cosmos.crypto.secp256k1.PubKey'
  }

  return {
    signer,
    registry,
    getFee,
    simulate,
    signAndBroadcast,
    signAndBroadcastWithoutBalanceCheck
  };
}

export default SigningClient;
