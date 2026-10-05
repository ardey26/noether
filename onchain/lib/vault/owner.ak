//// Owner-authorised paths: one-shot init and `OwnerManage`.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use vault/config.{canonical_address, find_config, holds_config_nft}
use vault/owners.{is_valid_config, threshold_met}
use vault/types.{ConfigDatum, config_token_name}

/// A config output is well formed when it sits at the canonical address,
/// carries only ADA plus the config NFT, has no reference script, and holds
/// a valid inline `ConfigDatum`.
fn is_valid_config_output(output: Output, vault: ScriptHash) -> Bool {
  and {
    output.address == canonical_address(vault),
    assets.without_lovelace(output.value) == assets.from_asset(
      vault,
      config_token_name,
      1,
    ),
    output.reference_script == None,
    when output.datum is {
      InlineDatum(raw) ->
        if raw is cfg: ConfigDatum {
          is_valid_config(cfg)
        } else {
          False
        }
      _ -> False
    },
  }
}

/// `InitConfig`: one-shot mint of the config NFT. Ported from SundaeSwap
/// treasury-contracts `validators/oneshot.ak`, hardened to pin the token name,
/// the quantity and the destination output.
pub fn init_config(seed: OutputReference, vault: ScriptHash, tx: Transaction) {
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })
  expect
    dict.to_pairs(assets.tokens(tx.mint, vault)) == [
      Pair(config_token_name, 1),
    ]
  expect [output] =
    list.filter(tx.outputs, fn(o) { holds_config_nft(o, vault) })
  is_valid_config_output(output, vault)
}

/// `OwnerManage` on any vault UTxO. Requires the owner threshold and never
/// decodes an allowance datum, so a corrupted allowance can always be
/// reclaimed (edge U6). When the spent UTxO is the config itself, the
/// threshold of the *current* owners applies and the NFT must be re-locked
/// with a valid datum.
pub fn owner_manage(own_input: Input, vault: ScriptHash, tx: Transaction) {
  if holds_config_nft(own_input.output, vault) {
    expect InlineDatum(raw) = own_input.output.datum
    expect current: ConfigDatum = raw
    expect threshold_met(current, tx.extra_signatories)
    expect [next] =
      list.filter(tx.outputs, fn(o) { holds_config_nft(o, vault) })
    is_valid_config_output(next, vault)
  } else {
    threshold_met(find_config(tx, vault), tx.extra_signatories)
  }
}
