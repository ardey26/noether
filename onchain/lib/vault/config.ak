use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/option
use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use vault/types.{ConfigDatum, config_token_name}

/// The vault's only address: payment = vault script, no stake credential.
/// With no stake credential there is nothing to deregister and no rewards
/// to strand (edges I1, I2).
pub fn canonical_address(vault: ScriptHash) -> Address {
  Address { payment_credential: Script(vault), stake_credential: None }
}

pub fn holds_config_nft(output: Output, vault: ScriptHash) -> Bool {
  assets.quantity_of(output.value, vault, config_token_name) == 1
}

/// Find and decode the vault config.
///
/// Ported from SundaeSwap treasury-contracts `find_script_hash_registry`,
/// hardened: it also checks the canonical address, because our config UTxO
/// lives at a spendable address rather than an always-fail one. Reference
/// inputs are searched first; the config is a spent input only when the
/// owners are updating it in this very tx, and then the pre-update datum
/// governs (edge D4).
pub fn find_config(tx: Transaction, vault: ScriptHash) -> ConfigDatum {
  let is_config =
    fn(input: Input) { holds_config_nft(input.output, vault) }
  expect Some(input) =
    list.find(tx.reference_inputs, is_config)
      |> option.or_try(fn() { list.find(tx.inputs, is_config) })
  expect input.output.address == canonical_address(vault)
  expect InlineDatum(raw) = input.output.datum
  expect cfg: ConfigDatum = raw
  cfg
}

/// Ported from SundaeSwap treasury-contracts `ensure_no_ref_scripts`.
/// Reference scripts on outputs inflate fees and min-ADA.
pub fn no_ref_scripts(outputs: List<Output>) -> Bool {
  list.all(outputs, fn(o) { option.is_none(o.reference_script) })
}
