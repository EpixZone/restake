# Epix validator compatibility

This fork retains the upstream validator-run REStake service and its registry
configuration. It does not introduce a central operator. Existing validators
keep their own bot account, signing-key storage and service schedule.

Epix accounts can have account numbers anywhere in the unsigned 64-bit range.
The signing client preserves account numbers and sequences as decimal strings
and unsigned Long values. Unsafe JavaScript numbers, negative values and
out-of-range integers are rejected before signing. Simulation gas and fee
rounding use exact arithmetic.

The Ethermint signer exposes the Ethereum-derived account address for its
verified public key. A request for another account is rejected. Broadcast
failures and confirmation timeouts reject instead of returning an Error object
as a successful result. A timeout is an unknown outcome, not proof of rejection.
Check the transaction hash before manually repeating an uncertain submission.

The existing runner uses delegate-only StakeAuthorization through MsgExec.
It supports a validator allow-list, cumulative max_tokens allowance and future
expiration. New grants do not need reward-withdrawal authorization. The runner
expects an existing delegation and the delegator's own reward-withdrawal address.
The operator pays transaction fees.

## Verification

```sh
npm ci --ignore-scripts
npm test
```

The regression suite uses the locked codecs and public fixtures to cover the
unsigned 64-bit boundaries, Ethermint signing, nested account responses,
simulation and fee arithmetic, signer identity and failure propagation.
No test requires a production key or broadcasts to a public network.

The patch was also exercised with the deployed Epix v0.7.3 binary in a private
loopback-only chain. A fresh operator with an account number above 2^63 executed
the existing NetworkRunner's MsgExec successfully. A delegator with zero liquid
balance compounded accrued rewards, and the operator paid the fee. This proves
the compatibility path; operators still need to monitor their own deployments.
