use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use vault/multisig.{AtLeast, Signature}
use vault/types.{ConfigDatum, max_owners}

/// Owner-set invariants (edge D5). Checked on-chain whenever a config datum
/// is written (init and every config update), so a config read from the
/// config NFT's UTxO is always valid.
pub fn is_valid_config(cfg: ConfigDatum) -> Bool {
  let n = list.length(cfg.owners)
  // `n >= 1` is implied by `1 <= threshold <= n`.
  and {
    n <= max_owners,
    cfg.threshold >= 1,
    cfg.threshold <= n,
    list.all(cfg.owners, fn(k) { bytearray.length(k) == 28 }),
    list.unique(cfg.owners) == cfg.owners,
    cfg.max_tx_validity_ms > 0,
  }
}

/// True when at least `threshold` distinct owners signed the tx.
pub fn threshold_met(
  cfg: ConfigDatum,
  signatories: List<VerificationKeyHash>,
) -> Bool {
  multisig.satisfied(
    AtLeast {
      required: cfg.threshold,
      scripts: list.map(cfg.owners, fn(k) { Signature(k) }),
    },
    signatories,
  )
}
