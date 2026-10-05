//// Allowance paths: creation/burn (mint), autonomous agent spend, and
//// co-signed over-limit spend.

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash, blake2b_224}
use aiken/primitive/bytearray
use aiken_design_patterns/validity_range_normalization.{
  ClosedRange, normalize_time_range,
}
use cardano/address.{Script, VerificationKey}
use cardano/assets.{AssetName, Assets}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use vault/config.{canonical_address, find_config, no_ref_scripts}
use vault/owners.{threshold_met}
use vault/types.{
  AllowanceDatum, ConfigDatum, config_token_name, max_assets, max_destinations,
}

/// Allowance token names are derived from a UTxO the creating tx spends, so
/// every name is globally unique and owners cannot mint a duplicate.
pub fn allowance_name(seed: OutputReference) -> AssetName {
  blake2b_224(cbor.serialise(seed))
}

/// The single vault token a UTxO holds, if it is an allowance token.
fn allowance_token(value: Assets, vault: ScriptHash) -> AssetName {
  expect [Pair(name, 1)] = dict.to_pairs(assets.tokens(value, vault))
  expect name != config_token_name
  name
}

// ---------------------------------------------------------------------------
// Mint: ManageAllowances

/// Owner threshold. Each minted allowance token has quantity 1, a name derived
/// from an input of this tx, and lands alone at the canonical address with an
/// inline datum. Burns (quantity -1) are allowed. The config NFT can never be
/// minted or burned here. Datum *contents* are validated where they are read
/// (agent paths); a bad datum fails closed and owners reclaim.
pub fn manage_allowances(vault: ScriptHash, tx: Transaction) -> Bool {
  expect threshold_met(find_config(tx, vault), tx.extra_signatories)
  let minted = dict.to_pairs(assets.tokens(tx.mint, vault))
  expect minted != []
  list.all(
    minted,
    fn(Pair(name, qty)) {
      and {
        name != config_token_name,
        or {
          qty == -1,
          and {
            qty == 1,
            list.any(
              tx.inputs,
              fn(i) { allowance_name(i.output_reference) == name },
            ),
            list.any(tx.outputs, fn(o) { is_allowance_output(o, vault, name) }),
          },
        },
      }
    },
  )
}

fn is_allowance_output(o: Output, vault: ScriptHash, name: AssetName) -> Bool {
  and {
    o.address == canonical_address(vault),
    dict.to_pairs(assets.tokens(o.value, vault)) == [Pair(name, 1)],
    o.reference_script == None,
    when o.datum is {
      InlineDatum(_) -> True
      _ -> False
    },
  }
}

// ---------------------------------------------------------------------------
// Shared agent-path checks

fn decode_allowance(own_input: Input) -> AllowanceDatum {
  expect InlineDatum(raw) = own_input.output.datum
  expect d: AllowanceDatum = raw
  d
}

/// Full read-time validation of an allowance datum, run on every agent-signed
/// spend (decision: deny by default). Every field is range-checked so that
/// no malformed value can read as permissive:
/// - empty allowlist, or any non-key destination: deny
/// - no caps, too many caps, negative caps: deny (a 0 cap denies that asset;
///   lovelace must be capped because the fee always leaves)
/// - `spent` of the wrong length or with a negative entry: deny (a negative
///   entry would otherwise extend the cap)
/// - period <= 0, expiry not after window start, negative max fee: deny
/// - agent key not 28 bytes: deny
/// An unparseable datum never reaches this function: decoding fails first.
pub fn is_well_formed(d: AllowanceDatum) -> Bool {
  let n_caps = list.length(d.caps)
  let n_dest = list.length(d.destinations)
  and {
    bytearray.length(d.agent) == 28,
    n_dest >= 1,
    n_dest <= max_destinations,
    list.all(
      d.destinations,
      fn(a) {
        when a.payment_credential is {
          VerificationKey(_) -> True
          _ -> False
        }
      },
    ),
    n_caps >= 1,
    n_caps <= max_assets,
    list.all(d.caps, fn(c) { c.window_cap >= 0 && c.tx_cap >= 0 }),
    list.length(d.spent) == n_caps,
    list.all(d.spent, fn(s) { s >= 0 }),
    d.period_ms > 0,
    d.expires_at > d.window_start,
    d.max_fee >= 0,
  }
}

/// Checks every agent-signed path shares: intent record present, vault not
/// paused (pause is literal: it blocks every agent-signed path), agent is not an
/// owner (edge D6),
/// agent signed.
fn agent_preconditions(
  cfg: ConfigDatum,
  d: AllowanceDatum,
  intent_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  and {
    bytearray.length(intent_hash) == 32,
    !cfg.paused,
    !list.has(cfg.owners, d.agent),
    list.has(tx.extra_signatories, d.agent),
  }
}

// ---------------------------------------------------------------------------
// Spend: AgentSpend

/// The autonomous path. See the README section "On-chain rules" for the rule list.
pub fn agent_spend(
  own_input: Input,
  vault: ScriptHash,
  intent_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  // 1. The allowance is the only input (edges U1, U2, V2; no treasury or
  //    other allowance can be touched).
  expect [_] = tx.inputs
  // 2. Nothing else may move value in or out (edge V3).
  expect assets.is_zero(tx.mint)
  expect tx.withdrawals == []
  expect tx.certificates == []
  expect tx.votes == []
  expect tx.proposal_procedures == []
  expect tx.treasury_donation == None

  let cfg = find_config(tx, vault)
  let d = decode_allowance(own_input)
  expect is_well_formed(d)
  expect agent_preconditions(cfg, d, intent_hash, tx)
  let token = allowance_token(own_input.output.value, vault)

  // 7. Time: one closed range, inside a single window, before expiry.
  expect ClosedRange { lower, upper } = normalize_time_range(tx.validity_range)
  expect upper - lower + 1 <= cfg.max_tx_validity_ms
  expect upper < d.expires_at
  expect lower >= d.window_start
  let k = ( lower - d.window_start ) / d.period_ms
  let window_start = d.window_start + k * d.period_ms
  expect upper < window_start + d.period_ms
  let base_spent =
    if k == 0 {
      d.spent
    } else {
      list.repeat(0, list.length(d.caps))
    }

  // 5. Exactly one output at the vault payment credential: the continuing one.
  let (vault_outputs, payments) =
    list.partition(
      tx.outputs,
      fn(o) { o.address.payment_credential == Script(vault) },
    )
  expect [continuing] = vault_outputs
  expect continuing.address == canonical_address(vault)
  expect assets.quantity_of(continuing.value, vault, token) == 1
  expect no_ref_scripts(tx.outputs)

  // 3-4. Everything that left the allowance (payments, change, fee) is
  //      input - continuing. Every asset in it must be capped (edge V4).
  let delta =
    assets.merge(own_input.output.value, assets.negate(continuing.value))
  expect
    list.all(
      assets.flatten(delta),
      fn((p, n, q)) {
        q > 0 && list.any(d.caps, fn(c) { c.policy == p && c.name == n })
      },
    )
  expect tx.fee <= d.max_fee
  let new_spent =
    list.map2(
      d.caps,
      base_spent,
      fn(c, s) {
        let q = assets.quantity_of(delta, c.policy, c.name)
        expect q <= c.tx_cap
        expect s + q <= c.window_cap
        s + q
      },
    )

  // 5. The agent never writes its own datum (edges U4, U6).
  expect
    continuing.datum == InlineDatum(
      AllowanceDatum { ..d, spent: new_spent, window_start: window_start },
    )

  // 6. Every other output pays an allowed destination, matched on the exact
  //    full address (edge D1). v1 destinations are key addresses only.
  //    Destinations are key-only by `is_well_formed`.
  list.all(payments, fn(o) { list.has(d.destinations, o.address) })
}

// ---------------------------------------------------------------------------
// Spend: CoSignedSpend

/// Over-limit path: one tx carrying the agent's signature and the owner
/// threshold. Owners alone could already move these funds via OwnerManage;
/// this path exists so that agent-initiated spends stay attributable
/// (intent record, agent signature) and obey the pause.
pub fn co_signed_spend(
  own_input: Input,
  vault: ScriptHash,
  intent_hash: ByteArray,
  tx: Transaction,
) -> Bool {
  let cfg = find_config(tx, vault)
  let d = decode_allowance(own_input)
  and {
    is_well_formed(d),
    agent_preconditions(cfg, d, intent_hash, tx),
    threshold_met(cfg, tx.extra_signatories),
  }
}
