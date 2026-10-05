//// Property tests for the allowance paths.
////
//// Malformed-datum properties come in three layers so a
//// pass can't be an accident:
////   1. `is_well_formed` rejects every malformed datum (no fixture involved);
////   2. agent spend fails end to end for every malformed datum;
////   3. owner reclaim succeeds for every malformed datum, typed or garbage.
//// A positive property shows `is_well_formed` is not vacuously strict.

use aiken/collection/list
use aiken/fuzz
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{Input, Transaction}
use vault/allowance.{agent_spend, is_well_formed}
use vault/allowance_fixtures.{
  Scenario, allowance_input, build, day, default, dest_a, hour, intent,
  lovelace_cap, pay, scenario, t0, token, untyped, usd_cap,
}
use vault/fixtures.{
  ada, cfg_2_of_3, config_input, key, owner_a, owner_b, plain_output, vault,
  wallet, wallet_with_stake,
}
use vault/owner.{owner_manage}
use vault/types.{AllowanceDatum, max_assets, max_destinations}

fn base() -> AllowanceDatum {
  allowance_fixtures.base_datum()
}

// ---------------------------------------------------------------------------
// Generators

/// A datum that is malformed or out of range in exactly one field (or
/// deny-by-value, e.g. a zero lovelace cap or an expiry already past),
/// everything else valid. Each case carries a label for coverage stats.
fn malformed_datum() -> Fuzzer<AllowanceDatum> {
  let d = base()
  fuzz.either9(
    // empty allowlist
    fuzz.constant(AllowanceDatum { ..d, destinations: [] }),
    // a script destination hidden among key destinations
    fuzz.bytearray_fixed(28)
      |> fuzz.map(
          fn(h) {
            AllowanceDatum {
              ..d,
              destinations: [
                dest_a(),
                Address { payment_credential: Script(h), stake_credential: None },
              ],
            }
          },
        ),
    // too many destinations
    fuzz.int_between(max_destinations + 1, max_destinations + 6)
      |> fuzz.map(fn(n) { AllowanceDatum { ..d, destinations: list.repeat(dest_a(), n) } }),
    // no caps / too many caps
    fuzz.int_between(0, 3)
      |> fuzz.map(
          fn(n) {
            if n == 0 {
              AllowanceDatum { ..d, caps: [], spent: [] }
            } else {
              let caps = list.repeat(lovelace_cap(50_000_000, 20_000_000), max_assets + n)
              AllowanceDatum { ..d, caps: caps, spent: list.repeat(0, max_assets + n) }
            }
          },
        ),
    // negative window or tx cap on either asset
    fuzz.tuple3(fuzz.int_between(-1_000_000_000, -1), fuzz.bool(), fuzz.bool())
      |> fuzz.map(
          fn((neg, on_lovelace, on_window)) {
            let caps =
              if on_lovelace {
                if on_window {
                  [lovelace_cap(neg, 20_000_000), usd_cap(1000, 600)]
                } else {
                  [lovelace_cap(50_000_000, neg), usd_cap(1000, 600)]
                }
              } else {
                if on_window {
                  [lovelace_cap(50_000_000, 20_000_000), usd_cap(neg, 600)]
                } else {
                  [lovelace_cap(50_000_000, 20_000_000), usd_cap(1000, neg)]
                }
              }
            AllowanceDatum { ..d, caps: caps }
          },
        ),
    // negative spent (would otherwise extend the cap) or wrong length
    fuzz.both(fuzz.int_between(-1_000_000_000_000, -1), fuzz.int_between(0, 3))
      |> fuzz.map(
          fn((neg, shape)) {
            when shape is {
              0 -> AllowanceDatum { ..d, spent: [neg, 0] }
              1 -> AllowanceDatum { ..d, spent: [0, neg] }
              2 -> AllowanceDatum { ..d, spent: [0] }
              _ -> AllowanceDatum { ..d, spent: [0, 0, 0] }
            }
          },
        ),
    // period <= 0
    fuzz.int_between(-10 * day, 0)
      |> fuzz.map(fn(p) { AllowanceDatum { ..d, period_ms: p } }),
    // expiry not after window start, or already past for the tx
    fuzz.int_between(t0 - 365 * day, t0 + hour + 10 * 60_000)
      |> fuzz.map(fn(e) { AllowanceDatum { ..d, expires_at: e } }),
    // negative max fee, zero lovelace cap, or an agent key of the wrong length
    fuzz.both(fuzz.int_between(0, 2), fuzz.bytearray_between(0, 40))
      |> fuzz.map(
          fn((which, bytes)) {
            when which is {
              0 -> AllowanceDatum { ..d, max_fee: -1 - bytearray.length(bytes) }
              1 -> AllowanceDatum { ..d, caps: [lovelace_cap(0, 0), usd_cap(1000, 600)] }
              _ ->
                if bytearray.length(bytes) == 28 {
                  AllowanceDatum { ..d, agent: #"" }
                } else {
                  AllowanceDatum { ..d, agent: bytes }
                }
            }
          },
        ),
  )
}

/// Arbitrary `Data` that is not an `AllowanceDatum` (unparseable).
fn garbage() -> Fuzzer<Data> {
  fuzz.data()
    |> fuzz.such_that(
        fn(x) {
          if x is AllowanceDatum {
            False
          } else {
            True
          }
        },
      )
}

/// A well-formed datum with random (in-range) field values.
fn well_formed_datum() -> Fuzzer<AllowanceDatum> {
  fuzz.tuple5(
    fuzz.int_between(1, max_destinations),
    fuzz.int_between(1, max_assets),
    fuzz.int_between(0, 1_000_000_000),
    fuzz.int_between(1, 365 * day),
    fuzz.int_between(0, 10_000_000),
  )
    |> fuzz.map(
        fn((n_dest, n_caps, cap, period, max_fee)) {
          AllowanceDatum {
            ..base(),
            destinations: list.repeat(dest_a(), n_dest),
            caps: list.repeat(lovelace_cap(cap, cap), n_caps),
            spent: list.repeat(cap, n_caps),
            period_ms: period,
            expires_at: t0 + period,
            max_fee: max_fee,
          }
        },
      )
}

// ---------------------------------------------------------------------------
// Layer 1: the read-time check itself

test prop_is_well_formed_rejects_malformed(d via malformed_datum()) {
  // Cases that are deny-by-value (zero cap, past expiry) are well formed but
  // must still be denied; they are covered end to end by layer 2.
  let deny_by_value = or {
      d.caps == [lovelace_cap(0, 0), usd_cap(1000, 600)],
      and {
        d.expires_at > d.window_start,
        d.expires_at <= t0 + hour + 10 * 60_000,
      },
    }
  deny_by_value || !is_well_formed(d)
}

test prop_is_well_formed_accepts_in_range(d via well_formed_datum()) {
  is_well_formed(d)
}

// ---------------------------------------------------------------------------
// Layer 2: agent spend fails end to end

test prop_malformed_datum_agent_spend_fails(d via malformed_datum()) fail {
  let s = scenario(d)
  agent_spend(allowance_input(s), vault, intent, build(s))
}

test prop_garbage_datum_agent_spend_fails(x via garbage()) fail {
  let s = untyped(x)
  agent_spend(allowance_input(s), vault, intent, build(s))
}

// ---------------------------------------------------------------------------
// Layer 3: owner reclaim succeeds regardless

fn reclaim(datum: Data) -> Bool {
  let input = allowance_input(untyped(datum))
  let t =
    Transaction {
      ..build(untyped(datum)),
      inputs: [input],
      reference_inputs: [config_input(cfg_2_of_3())],
      outputs: [plain_output(wallet(owner_a), ada(99))],
      extra_signatories: [owner_a, owner_b],
      mint: assets.from_asset(vault, token(), -1),
    }
  owner_manage(input, vault, t)
}

test prop_malformed_datum_owner_reclaim_succeeds(d via malformed_datum()) {
  reclaim(d)
}

test prop_garbage_datum_owner_reclaim_succeeds(x via garbage()) {
  reclaim(x)
}

// ---------------------------------------------------------------------------
// Caps: acceptance is exactly "within tx cap and within window cap"

const fee: Int = 300_000

/// (already spent, amount paid) with spent + paid + fee <= 50 ADA and
/// paid + fee <= 20 ADA.
fn within_caps() -> Fuzzer<(Int, Int)> {
  fuzz.int_between(0, 50_000_000 - fee)
    |> fuzz.and_then(
        fn(spent) {
          let room = 50_000_000 - spent - fee
          let room =
            if room > 20_000_000 - fee {
              20_000_000 - fee
            } else {
              room
            }
          fuzz.int_between(0, room) |> fuzz.map(fn(paid) { (spent, paid) })
        },
      )
}

fn over_caps() -> Fuzzer<(Int, Int)> {
  fuzz.int_between(0, 50_000_000)
    |> fuzz.and_then(
        fn(spent) {
          let room = 50_000_000 - spent - fee
          let room =
            if room > 20_000_000 - fee {
              20_000_000 - fee
            } else {
              room
            }
          let min_over =
            if room < 0 {
              1
            } else {
              room + 1
            }
          fuzz.int_between(min_over, 90_000_000)
            |> fuzz.map(fn(paid) { (spent, paid) })
        },
      )
}

fn spend_scenario(spent: Int, paid: Int) -> Scenario {
  let s = scenario(AllowanceDatum { ..base(), spent: [spent, 0] })
  Scenario {
    ..s,
    payments: if paid == 0 {
      []
    } else {
      [pay(dest_a(), assets.from_lovelace(paid))]
    },
    fee: fee,
  }
}

test prop_spend_within_caps_accepted((spent, paid) via within_caps()) {
  let s = spend_scenario(spent, paid)
  agent_spend(allowance_input(s), vault, intent, build(s))
}

test prop_spend_over_caps_rejected((spent, paid) via over_caps()) fail {
  let s = spend_scenario(spent, paid)
  agent_spend(allowance_input(s), vault, intent, build(s))
}

// ---------------------------------------------------------------------------
// Windows: any range inside one window is accepted (and resets after the
// first window); any range that straddles a boundary is rejected.

fn range_inside_window() -> Fuzzer<(Int, Int)> {
  fuzz.tuple3(fuzz.int_between(0, 9), fuzz.int_between(0, day - 1), fuzz.int_between(1, hour))
    |> fuzz.map(
        fn((w, offset, width)) {
          let start = t0 + w * day
          let lower = start + offset
          let upper = lower + width - 1
          let upper =
            if upper >= start + day {
              start + day - 1
            } else {
              upper
            }
          (lower, upper)
        },
      )
}

fn range_straddling() -> Fuzzer<(Int, Int)> {
  fuzz.tuple3(fuzz.int_between(1, 9), fuzz.int_between(1, hour / 2), fuzz.int_between(0, hour / 2))
    |> fuzz.map(
        fn((w, before, after)) {
          let boundary = t0 + w * day
          (boundary - before, boundary + after)
        },
      )
}

test prop_range_inside_one_window_accepted((lower, upper) via range_inside_window()) {
  // Previous window fully spent: must still pass whenever a reset applies,
  // so only start from a full window when we are past the first one.
  let k = ( lower - t0 ) / day
  let spent =
    if k == 0 {
      [0, 0]
    } else {
      [50_000_000, 1000]
    }
  let s = scenario(AllowanceDatum { ..base(), spent: spent })
  let s = Scenario { ..s, lower: lower, upper: upper }
  agent_spend(allowance_input(s), vault, intent, build(s))
}

test prop_range_straddling_window_rejected((lower, upper) via range_straddling()) fail {
  let s = Scenario { ..default(), lower: lower, upper: upper }
  agent_spend(allowance_input(s), vault, intent, build(s))
}

// ---------------------------------------------------------------------------
// Destinations: any address outside the allowlist is rejected

test prop_unlisted_destination_rejected(
  (n, stake, with_stake) via fuzz.tuple3(fuzz.int_between(0, 255), fuzz.int_between(0, 255), fuzz.bool()),
) fail {
  // key(n) is never payee_a / payee_b (different prefix).
  let to =
    if with_stake {
      wallet_with_stake(key(n), key(stake))
    } else {
      wallet(key(n))
    }
  let s = Scenario { ..default(), payments: [pay(to, ada(1))] }
  agent_spend(allowance_input(s), vault, intent, build(s))
}
