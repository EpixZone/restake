import { ETH } from "@tharsis/address-converter";
import Bech32 from "bech32";

import * as BytesUtils from "@ethersproject/bytes";
import { keccak256 } from "@ethersproject/keccak256";
import { encodeSecp256k1Signature } from '@cosmjs/amino';
import { makeSignBytes } from "@cosmjs/proto-signing";

function EthSigner(signer, ethSigner, prefix){
  async function signDirect(address, signDoc){
    const [account] = await getAccounts()
    if(address !== account.address){
      throw new Error('Requested account is not available from Ethermint signer')
    }
    const signature = await ethSigner
      ._signingKey()
      .signDigest(keccak256(makeSignBytes(signDoc)));
    const splitSignature = BytesUtils.splitSignature(signature);
    const result = BytesUtils.arrayify(
      BytesUtils.concat([splitSignature.r, splitSignature.s])
    );
    const pubkey = account.pubkey
    return {
      signed: signDoc,
      signature: encodeSecp256k1Signature(pubkey, result)
    }
  }

  async function getAddress(){
    const ethereumAddress = await ethSigner.getAddress();
    const data = ETH.decoder(ethereumAddress);
    return Bech32.encode(prefix, Bech32.toWords(data))
  }

  async function getAccounts(){
    const pubkey = ethSigner._signingKey().compressedPublicKey.toLowerCase()
    const account = (await signer.getAccounts()).find(account =>
      BytesUtils.hexlify(account.pubkey).toLowerCase() === pubkey)
    if(!account){
      throw new Error('Ethermint public key does not match the signer account')
    }
    // The wrapped Cosmos wallet hashes the same key differently. Expose the
    // Ethereum-derived address that this signer actually uses on chain.
    return [{ ...account, address: await getAddress() }]
  }

  return {
    signer,
    ethSigner,
    signDirect,
    getAddress,
    getAccounts
  }
}

export default EthSigner
