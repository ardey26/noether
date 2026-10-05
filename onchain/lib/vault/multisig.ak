//// Threshold signature check.
////
//// Vendored from SundaeSwap-finance/aicone@504e104, lib/sundae/multisig.ak
//// (Apache-2.0), the revision pinned by the TxPipe- and MLabs-audited
//// SundaeSwap-finance/treasury-contracts. Restricted to the `Signature` and
//// `AtLeast` constructors and to the `satisfied` evaluator; the logic of
//// those branches is unchanged.
////
//// Caveat inherited from upstream: `AtLeast` counts satisfied sub-scripts, so
//// a duplicated `Signature` counts twice. `owners.is_valid_config` rejects
//// duplicate owners for exactly this reason.

use aiken/collection/list

pub type MultisigScript {
  Signature { key_hash: ByteArray }
  AtLeast { required: Int, scripts: List<MultisigScript> }
}

pub fn satisfied(script: MultisigScript, signatories: List<ByteArray>) -> Bool {
  when script is {
    Signature { key_hash } -> list.has(signatories, key_hash)
    AtLeast { required, scripts } ->
      required <= list.count(scripts, fn(s) { satisfied(s, signatories) })
  }
}
