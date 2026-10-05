//// Test-only scenario builder for agent and co-signed paths. Builds the tx an
//// honest agent SDK would build; adversarial tests then mutate one aspect.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address}
use cardano/assets.{Value}
use cardano/transaction.{Input, Output, Transaction, placeholder}
use vault/allowance.{allowance_name}
use vault/config.{canonical_address}
use vault/fixtures.{
  ada, agent_key, cfg_2_of_3, config_input, out_ref, output, plain_output,
  vault, wallet, wallet_with_stake,
}
use vault/types.{AllowanceDatum, AssetCap, ConfigDatum}

pub const usd_policy: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"

pub const usd_name: ByteArray = "USD"

pub const junk_policy: ByteArray =
  #"6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e"

pub const payee_a: ByteArray =
  #"7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"

pub const payee_b: ByteArray =
  #"7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b"

pub const stake_x: ByteArray =
  #"8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c"

pub const stake_y: ByteArray =
  #"8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d"

/// 2026-01-01T00:00:00Z
pub const t0: Int = 1_767_225_600_000

pub const hour: Int = 3_600_000

pub const day: Int = 86_400_000

pub const intent: ByteArray =
  #"1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e"

pub fn token() -> ByteArray {
  allowance_name(out_ref(77))
}

pub fn dest_a() -> Address {
  wallet(payee_a)
}

/// payee_b, only with stake key stake_x.
pub fn dest_b() -> Address {
  wallet_with_stake(payee_b, stake_x)
}

pub fn lovelace_cap(window: Int, tx: Int) -> AssetCap {
  AssetCap { policy: #"", name: #"", window_cap: window, tx_cap: tx }
}

pub fn usd_cap(window: Int, tx: Int) -> AssetCap {
  AssetCap { policy: usd_policy, name: usd_name, window_cap: window, tx_cap: tx }
}

pub fn base_datum() -> AllowanceDatum {
  AllowanceDatum {
    agent: agent_key,
    destinations: [dest_a(), dest_b()],
    caps: [lovelace_cap(50_000_000, 20_000_000), usd_cap(1000, 600)],
    spent: [0, 0],
    window_start: t0,
    period_ms: day,
    expires_at: t0 + 30 * day,
    max_fee: 1_000_000,
  }
}

pub fn usd(n: Int) -> Value {
  assets.from_asset(usd_policy, usd_name, n)
}

pub fn state_value(lovelace_ada: Int, usd_amount: Int) -> Value {
  ada(lovelace_ada)
    |> assets.merge(usd(usd_amount))
    |> assets.merge(assets.from_asset(vault, token(), 1))
}

pub fn pay(to: Address, value: Value) -> Output {
  plain_output(to, value)
}

pub type Scenario {
  /// Datum on the spent allowance UTxO (may be malformed or garbage).
  input_datum: Data,
  /// When the input datum is well typed, the builder computes the continuing
  /// datum exactly as the validator does. `None` keeps the input datum.
  typed: Option<AllowanceDatum>,
  in_value: Value,
  payments: List<Output>,
  /// Inclusive first and last millisecond of validity.
  lower: Int,
  upper: Int,
  fee: Int,
  signers: List<VerificationKeyHash>,
  cfg: ConfigDatum,
}

pub fn scenario(d: AllowanceDatum) -> Scenario {
  Scenario {
    input_datum: d,
    typed: Some(d),
    in_value: state_value(100, 1000),
    payments: [pay(dest_a(), ada(5))],
    lower: t0 + hour,
    upper: t0 + hour + 10 * 60_000,
    fee: 300_000,
    signers: [agent_key],
    cfg: cfg_2_of_3(),
  }
}

pub fn default() -> Scenario {
  scenario(base_datum())
}

pub fn untyped(datum: Data) -> Scenario {
  Scenario { ..default(), input_datum: datum, typed: None }
}

fn sum(outputs: List<Output>) -> Value {
  list.foldl(outputs, assets.zero, fn(o, acc) { assets.merge(acc, o.value) })
}

pub fn expected_datum(
  d: AllowanceDatum,
  in_value: Value,
  continuing_value: Value,
  lower: Int,
) -> AllowanceDatum {
  // Mirrors the validator's arithmetic exactly (floor division), so an
  // adversarial test supplies the datum a lenient validator would accept.
  // Only a non-positive period is special-cased, to stay total.
  let k =
    if d.period_ms > 0 {
      ( lower - d.window_start ) / d.period_ms
    } else {
      0
    }
  let base =
    if k == 0 {
      d.spent
    } else {
      list.repeat(0, list.length(d.caps))
    }
  let delta = assets.merge(in_value, assets.negate(continuing_value))
  AllowanceDatum {
    ..d,
    window_start: d.window_start + k * d.period_ms,
    spent: list.map2(
      d.caps,
      base,
      fn(c, s) { s + assets.quantity_of(delta, c.policy, c.name) },
    ),
  }
}

pub fn continuing_value(s: Scenario) -> Value {
  s.in_value
    |> assets.merge(assets.negate(sum(s.payments)))
    |> assets.merge(assets.from_lovelace(-s.fee))
}

pub fn allowance_input(s: Scenario) -> Input {
  Input {
    output_reference: out_ref(10),
    output: output(canonical_address(vault), s.in_value, s.input_datum),
  }
}

pub fn continuing_output(s: Scenario) -> Output {
  let value = continuing_value(s)
  let datum: Data =
    when s.typed is {
      Some(d) -> {
          let as_data: Data = expected_datum(d, s.in_value, value, s.lower)
          as_data
        }
      None -> s.input_datum
    }
  output(canonical_address(vault), value, datum)
}

pub fn closed(lower: Int, upper_inclusive: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lower), is_inclusive: True },
    upper_bound: IntervalBound {
      bound_type: Finite(upper_inclusive + 1),
      is_inclusive: False,
    },
  }
}

pub fn build(s: Scenario) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [allowance_input(s)],
    reference_inputs: [config_input(s.cfg)],
    outputs: [continuing_output(s), ..s.payments],
    fee: s.fee,
    extra_signatories: s.signers,
    validity_range: closed(s.lower, s.upper),
  }
}
