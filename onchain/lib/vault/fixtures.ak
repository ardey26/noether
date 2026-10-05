//// Test-only builders. Nothing here is referenced by the validator, so none
//// of it reaches the compiled script.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{
  Address, Inline, Script, VerificationKey, from_verification_key,
}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  placeholder,
}
use vault/config.{canonical_address}
use vault/types.{ConfigDatum, config_token_name}

pub const vault: ByteArray =
  #"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"

pub const other_script: ByteArray =
  #"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"

/// Distinct 28-byte key hash for property tests: 27 bytes of 0xcc, prefixed by `n`.
pub fn key(n: Int) -> VerificationKeyHash {
  bytearray.push(#"cccccccccccccccccccccccccccccccccccccccccccccccccccccc", n)
}

pub const owner_a: ByteArray = #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

pub const owner_b: ByteArray = #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

pub const owner_c: ByteArray = #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

pub const owner_d: ByteArray = #"d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"

pub const agent_key: ByteArray = #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

pub const stranger: ByteArray = #"f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6"

pub fn cfg_2_of_3() -> ConfigDatum {
  ConfigDatum {
    owners: [owner_a, owner_b, owner_c],
    threshold: 2,
    paused: False,
    max_tx_validity_ms: 3_600_000,
  }
}

pub fn out_ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
    output_index: n,
  }
}

pub fn config_nft() -> Value {
  assets.from_asset(vault, config_token_name, 1)
}

pub fn ada(n: Int) -> Value {
  assets.from_lovelace(n * 1_000_000)
}

pub fn output(address: Address, value: Value, datum: Data) -> Output {
  Output { address, value, datum: InlineDatum(datum), reference_script: None }
}

pub fn plain_output(address: Address, value: Value) -> Output {
  Output { address, value, datum: NoDatum, reference_script: None }
}

pub fn config_output(cfg: ConfigDatum) -> Output {
  output(canonical_address(vault), assets.merge(ada(2), config_nft()), cfg)
}

pub fn config_input(cfg: ConfigDatum) -> Input {
  Input { output_reference: out_ref(900), output: config_output(cfg) }
}

pub fn treasury_input(n: Int, lovelace: Int) -> Input {
  Input {
    output_reference: out_ref(n),
    output: plain_output(canonical_address(vault), ada(lovelace)),
  }
}

pub fn wallet(k: VerificationKeyHash) -> Address {
  from_verification_key(k)
}

pub fn wallet_with_stake(
  k: VerificationKeyHash,
  stake: VerificationKeyHash,
) -> Address {
  Address {
    payment_credential: VerificationKey(k),
    stake_credential: Some(Inline(VerificationKey(stake))),
  }
}

pub fn script_address_with_stake(stake: VerificationKeyHash) -> Address {
  Address {
    payment_credential: Script(vault),
    stake_credential: Some(Inline(VerificationKey(stake))),
  }
}

pub fn range(lower: Int, upper: Int) -> Interval {
  // As the ledger presents it: lower inclusive, upper exclusive.
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lower), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(upper), is_inclusive: False },
  }
}

pub fn tx(
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: inputs,
    reference_inputs: reference_inputs,
    outputs: outputs,
    extra_signatories: signers,
    fee: 200_000,
  }
}

pub fn with_mint(t: Transaction, mint: Value) -> Transaction {
  Transaction { ..t, mint: mint }
}

pub fn signed_by(t: Transaction, signers: List<VerificationKeyHash>) -> Transaction {
  Transaction { ..t, extra_signatories: list.unique(signers) }
}
