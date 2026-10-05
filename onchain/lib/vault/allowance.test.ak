use aiken/collection/list
use aiken/interval.{Finite, Interval, IntervalBound, NegativeInfinity, PositiveInfinity}
use cardano/address.{Address, Pointer, Script, VerificationKey}
use cardano/assets
use cardano/certificate.{RegisterCredential}
use cardano/transaction.{DatumHash, InlineDatum, Input, Output, Transaction}
use vault/allowance.{agent_spend, co_signed_spend}
use vault/allowance_fixtures.{
  Scenario, allowance_input, build, continuing_output, day, default,
  dest_a, dest_b, hour, intent, junk_policy, lovelace_cap, pay, payee_a,
  payee_b, scenario, stake_x, stake_y, state_value, t0, token, usd, usd_cap,
}
use vault/config.{canonical_address}
use vault/fixtures.{
  ada, agent_key, cfg_2_of_3, config_input, other_script, out_ref, output,
  owner_a, owner_b, owner_c, plain_output, script_address_with_stake, stranger,
  treasury_input, vault, wallet, wallet_with_stake,
}
use vault/types.{AllowanceDatum, ConfigDatum}

fn run(s: Scenario) -> Bool {
  agent_spend(allowance_input(s), vault, intent, build(s))
}

fn run_tx(s: Scenario, t: Transaction) -> Bool {
  agent_spend(allowance_input(s), vault, intent, t)
}

fn with_datum(f: fn(AllowanceDatum) -> AllowanceDatum) -> Scenario {
  scenario(f(allowance_fixtures.base_datum()))
}

// ===========================================================================
// Happy paths

test pays_allowed_destination() {
  run(default())
}

test pays_destination_with_exact_stake_part() {
  run(Scenario { ..default(), payments: [pay(dest_b(), ada(3))] })
}

test pays_whitelisted_token() {
  run(Scenario { ..default(), payments: [pay(dest_a(), assets.merge(ada(2), usd(400)))] })
}

test fee_only_spend_counts_fee() {
  // No payments: only the fee leaves, and it is counted.
  run(Scenario { ..default(), payments: [] })
}

test several_payments_in_one_tx() {
  run(
    Scenario {
      ..default(),
      payments: [pay(dest_a(), ada(5)), pay(dest_b(), ada(5)), pay(dest_a(), usd(100))],
    },
  )
}

test accumulates_within_window() {
  // 40 ADA already spent; 5 ADA + fee keeps total under 50 ADA.
  run(with_datum(fn(d) { AllowanceDatum { ..d, spent: [40_000_000, 0] } }))
}

test window_resets_on_its_own() {
  // Previous window fully spent; a spend in the next window starts from zero.
  let s = with_datum(fn(d) { AllowanceDatum { ..d, spent: [50_000_000, 1000] } })
  run(Scenario { ..s, lower: t0 + day + hour, upper: t0 + day + hour + 30 * 60_000 })
}

test window_skips_several_periods() {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, spent: [50_000_000, 1000] } })
  run(Scenario { ..s, lower: t0 + 7 * day, upper: t0 + 7 * day + 30 * 60_000 })
}

test huge_caps_no_overflow() {
  // Edge T4: Plutus integers are unbounded.
  let big = 1_000_000_000_000_000_000_000_000_000_000
  run(with_datum(fn(d) { AllowanceDatum { ..d, caps: [lovelace_cap(big, big), usd_cap(big, big)] } }))
}

// ===========================================================================
// Value edges

test v1_fee_above_max_fee() fail {
  run(Scenario { ..default(), fee: 1_000_001 })
}

test v1_absurd_fee_counts_against_cap() fail {
  // max_fee raised by owners, but the fee still counts toward the window cap.
  let s = with_datum(fn(d) { AllowanceDatum { ..d, max_fee: 100_000_000, spent: [45_000_000, 0] } })
  run(Scenario { ..s, payments: [], fee: 6_000_000 })
}

test v2_change_to_agent_address_rejected() fail {
  run(Scenario { ..default(), payments: [pay(dest_a(), ada(1)), pay(wallet(agent_key), ada(10))] })
}

test v2_dust_to_agent_address_rejected() fail {
  run(Scenario { ..default(), payments: [pay(wallet(agent_key), assets.from_lovelace(1))] })
}

test v2_change_counted_even_when_paid_to_allowed_destination() fail {
  // 25 ADA "change" to an allowed destination exceeds the per-tx cap (20 ADA).
  run(Scenario { ..default(), payments: [pay(dest_a(), ada(25))] })
}

test v3_mint_in_agent_spend() fail {
  let s = default()
  run_tx(s, Transaction { ..build(s), mint: assets.from_asset(junk_policy, "x", 1) })
}

test v3_burn_in_agent_spend() fail {
  let s = default()
  run_tx(s, Transaction { ..build(s), mint: assets.from_asset(junk_policy, "x", -1) })
}

test v4_non_whitelisted_token_rides_along() fail {
  // The allowance UTxO holds a junk token (e.g. airdropped by owners by
  // mistake); the agent tries to move it out.
  let s =
    Scenario {
      ..default(),
      in_value: assets.merge(state_value(100, 1000), assets.from_asset(junk_policy, "j", 5)),
      payments: [pay(dest_a(), assets.merge(ada(2), assets.from_asset(junk_policy, "j", 5)))],
    }
  run(s)
}

test v4_non_whitelisted_token_may_stay_put() {
  // Junk that stays in the continuing output is not "spent".
  let s =
    Scenario {
      ..default(),
      in_value: assets.merge(state_value(100, 1000), assets.from_asset(junk_policy, "j", 5)),
    }
  run(s)
}

test value_extra_withdrawal_rejected() fail {
  let s = default()
  run_tx(s, Transaction { ..build(s), withdrawals: [Pair(VerificationKey(stranger), 1)] })
}

test value_certificate_rejected() fail {
  let s = default()
  run_tx(
    s,
    Transaction {
      ..build(s),
      certificates: [RegisterCredential { credential: VerificationKey(stranger), deposit: Never }],
    },
  )
}

test value_treasury_donation_rejected() fail {
  let s = default()
  run_tx(s, Transaction { ..build(s), treasury_donation: Some(1) })
}

// ===========================================================================
// Caps

test cap_per_tx_lovelace() fail {
  run(Scenario { ..default(), payments: [pay(dest_a(), ada(20))] })
}

test cap_per_tx_lovelace_exact_edge_ok() {
  // 19.7 ADA + 0.3 ADA fee = exactly the 20 ADA tx cap.
  run(Scenario { ..default(), payments: [pay(dest_a(), assets.from_lovelace(19_700_000))] })
}

test cap_window_lovelace() fail {
  run(with_datum(fn(d) { AllowanceDatum { ..d, spent: [45_000_000, 0] } }))
}

test cap_window_lovelace_exact_edge_ok() {
  // 44.7 + 5 + 0.3 = 50 ADA exactly.
  run(with_datum(fn(d) { AllowanceDatum { ..d, spent: [44_700_000, 0] } }))
}

test cap_per_tx_token() fail {
  run(Scenario { ..default(), payments: [pay(dest_a(), assets.merge(ada(2), usd(601)))] })
}

test cap_window_token() fail {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, spent: [0, 900] } })
  run(Scenario { ..s, payments: [pay(dest_a(), assets.merge(ada(2), usd(101)))] })
}

test cap_zero_denies_that_asset() fail {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, caps: [lovelace_cap(50_000_000, 20_000_000), usd_cap(0, 0)] } })
  run(Scenario { ..s, payments: [pay(dest_a(), assets.merge(ada(2), usd(1)))] })
}

test cap_zero_on_lovelace_denies_everything() fail {
  // The fee always leaves, so a zero lovelace cap denies every spend.
  run(with_datum(fn(d) { AllowanceDatum { ..d, caps: [lovelace_cap(0, 0), usd_cap(1000, 600)] } }))
}

test cap_missing_lovelace_denies_everything() fail {
  run(with_datum(fn(d) { AllowanceDatum { ..d, caps: [usd_cap(1000, 600)], spent: [0] } }))
}

test cap_state_token_cannot_leave() fail {
  let s = default()
  let t = build(s)
  // Move the allowance token into the payment instead of the continuing output.
  let cont = continuing_output(s)
  let tok = assets.from_asset(vault, token(), 1)
  let cont2 = Output { ..cont, value: assets.merge(cont.value, assets.negate(tok)) }
  let pay2 = pay(dest_a(), assets.merge(ada(5), tok))
  run_tx(s, Transaction { ..t, outputs: [cont2, pay2] })
}

// ===========================================================================
// UTxO structure

test u1_second_input_rejected() fail {
  // Double satisfaction / treasury access: any second input is refused.
  let s = default()
  let t = build(s)
  run_tx(s, Transaction { ..t, inputs: [allowance_input(s), treasury_input(1, 500)] })
}

test u1_two_allowances_one_output() fail {
  let s = default()
  let t = build(s)
  let other = Input { ..allowance_input(s), output_reference: out_ref(11) }
  run_tx(s, Transaction { ..t, inputs: [allowance_input(s), other] })
}

test u1_agent_wallet_input_rejected() fail {
  let s = default()
  let t = build(s)
  let wallet_in = Input { output_reference: out_ref(50), output: plain_output(wallet(agent_key), ada(10)) }
  run_tx(s, Transaction { ..t, inputs: [allowance_input(s), wallet_in] })
}

test u2_split_into_two_vault_outputs() fail {
  let s = default()
  let t = build(s)
  let cont = continuing_output(s)
  let half = Output { ..cont, value: ada(10) }
  run_tx(s, Transaction { ..t, outputs: [cont, half, ..s.payments] })
}

test u2_continuing_output_with_stake_credential() fail {
  let s = default()
  let t = build(s)
  let cont = Output { ..continuing_output(s), address: script_address_with_stake(stranger) }
  run_tx(s, Transaction { ..t, outputs: [cont, ..s.payments] })
}

test u3_fake_allowance_without_token() fail {
  // A UTxO planted at the vault address with a perfect datum but no token.
  let s = Scenario { ..default(), in_value: assets.merge(ada(100), usd(1000)) }
  run(s)
}

test u3_fake_allowance_with_foreign_token() fail {
  let s =
    Scenario {
      ..default(),
      in_value: ada(100) |> assets.merge(usd(1000)) |> assets.merge(assets.from_asset(other_script, token(), 1)),
    }
  run(s)
}

test u3_agent_spend_on_config_utxo() fail {
  let s = default()
  let cfg_in = config_input(cfg_2_of_3())
  agent_spend(cfg_in, vault, intent, Transaction { ..build(s), inputs: [cfg_in] })
}

test u4_agent_writes_own_datum() fail {
  // Continuing datum claims nothing was spent.
  let s = default()
  let t = build(s)
  let cont = Output { ..continuing_output(s), datum: InlineDatum(allowance_fixtures.base_datum()) }
  run_tx(s, Transaction { ..t, outputs: [cont, ..s.payments] })
}

test u4_oversized_continuing_datum() fail {
  let s = default()
  let t = build(s)
  let bloated = AllowanceDatum { ..allowance_fixtures.base_datum(), destinations: list.repeat(dest_a(), 500) }
  let cont = Output { ..continuing_output(s), datum: InlineDatum(bloated) }
  run_tx(s, Transaction { ..t, outputs: [cont, ..s.payments] })
}

test u4_junk_tokens_into_continuing_output() fail {
  // Junk added to the continuing output shows up as a negative delta.
  let s = default()
  let t = build(s)
  let cont = continuing_output(s)
  let cont2 = Output { ..cont, value: assets.merge(cont.value, assets.from_asset(junk_policy, "j", 1000)) }
  run_tx(s, Transaction { ..t, outputs: [cont2, ..s.payments] })
}

test u4_reference_script_on_continuing_output() fail {
  let s = default()
  let t = build(s)
  let cont = Output { ..continuing_output(s), reference_script: Some(other_script) }
  run_tx(s, Transaction { ..t, outputs: [cont, ..s.payments] })
}

test u4_reference_script_on_payment() fail {
  let s = default()
  let t = build(s)
  let p = Output { ..pay(dest_a(), ada(5)), reference_script: Some(other_script) }
  run_tx(s, Transaction { ..t, outputs: [continuing_output(s), p] })
}

test u5_continuing_datum_by_hash() fail {
  let s = default()
  let t = build(s)
  let cont = Output { ..continuing_output(s), datum: DatumHash(#"abcd") }
  run_tx(s, Transaction { ..t, outputs: [cont, ..s.payments] })
}

test u5_input_datum_by_hash() fail {
  let s = default()
  let i = allowance_input(s)
  let i2 = Input { ..i, output: Output { ..i.output, datum: DatumHash(#"abcd") } }
  agent_spend(i2, vault, intent, Transaction { ..build(s), inputs: [i2] })
}

// ===========================================================================
// Time

fn with_range(s: Scenario, r: Interval) -> Bool {
  run_tx(s, Transaction { ..build(s), validity_range: r })
}

test t1_unbounded_upper() fail {
  with_range(
    default(),
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(t0 + hour), is_inclusive: True },
      upper_bound: IntervalBound { bound_type: PositiveInfinity, is_inclusive: True },
    },
  )
}

test t1_unbounded_lower() fail {
  with_range(
    default(),
    Interval {
      lower_bound: IntervalBound { bound_type: NegativeInfinity, is_inclusive: True },
      upper_bound: IntervalBound { bound_type: Finite(t0 + 2 * hour), is_inclusive: False },
    },
  )
}

test t1_fully_unbounded() fail {
  with_range(default(), interval.everything)
}

test t2_straddles_two_windows() fail {
  run(Scenario { ..default(), lower: t0 + day - 5 * 60_000, upper: t0 + day + 5 * 60_000 })
}

test t2_wider_than_max_validity() fail {
  // max_tx_validity_ms is 1h; a 1h + 1ms range is refused even inside a window.
  run(Scenario { ..default(), lower: t0 + hour, upper: t0 + 2 * hour })
}

test t2_exactly_max_validity_ok() {
  run(Scenario { ..default(), lower: t0 + hour, upper: t0 + 2 * hour - 1 })
}

test t3_lower_at_window_start_ok() {
  run(Scenario { ..default(), lower: t0, upper: t0 + 60_000 })
}

test t3_lower_before_window_start() fail {
  run(Scenario { ..default(), lower: t0 - 1, upper: t0 + 60_000 })
}

test t3_upper_at_last_ms_of_window_ok() {
  run(Scenario { ..default(), lower: t0 + day - 60_000, upper: t0 + day - 1 })
}

test t3_upper_at_first_ms_of_next_window() fail {
  run(Scenario { ..default(), lower: t0 + day - 60_000, upper: t0 + day })
}

test t3_lower_at_first_ms_of_next_window_rolls() {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, spent: [50_000_000, 1000] } })
  run(Scenario { ..s, lower: t0 + day, upper: t0 + day + 60_000 })
}

test t3_inclusive_upper_bound_normalised() {
  // Same last ms as the exclusive form: [lower, t0+day-1] inclusive.
  let s = Scenario { ..default(), lower: t0 + day - 60_000, upper: t0 + day - 1 }
  with_range(
    s,
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(t0 + day - 60_000), is_inclusive: True },
      upper_bound: IntervalBound { bound_type: Finite(t0 + day - 1), is_inclusive: True },
    },
  )
}

test t3_inclusive_upper_bound_past_window() fail {
  let s = Scenario { ..default(), lower: t0 + day - 60_000, upper: t0 + day - 1 }
  with_range(
    s,
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(t0 + day - 60_000), is_inclusive: True },
      upper_bound: IntervalBound { bound_type: Finite(t0 + day), is_inclusive: True },
    },
  )
}

test t3_exclusive_lower_bound_normalised() fail {
  // (t0 - 1, ...] exclusive is t0 inclusive: fine on its own, but the
  // builder's datum assumes lower = t0 - 1, so to isolate the bound we check
  // the reject side: exclusive lower at t0 - 2 means first ms t0 - 1 < start.
  let s = Scenario { ..default(), lower: t0 - 1, upper: t0 + 60_000 }
  with_range(
    s,
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(t0 - 2), is_inclusive: False },
      upper_bound: IntervalBound { bound_type: Finite(t0 + 60_001), is_inclusive: False },
    },
  )
}

test t3_upper_at_last_ms_before_expiry_ok() {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, expires_at: t0 + 2 * hour } })
  run(Scenario { ..s, lower: t0 + hour, upper: t0 + 2 * hour - 1 })
}

test t3_upper_at_expiry() fail {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, expires_at: t0 + 2 * hour } })
  run(Scenario { ..s, lower: t0 + hour + 1, upper: t0 + 2 * hour })
}

test t4_expired_allowance() fail {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, expires_at: t0 + 30 * 60_000 } })
  run(s)
}

test t4_window_start_in_future() fail {
  run(with_datum(fn(d) { AllowanceDatum { ..d, window_start: t0 + 2 * hour, expires_at: t0 + 30 * day } }))
}

// ===========================================================================
// Destinations

test d1_swapped_stake_credential() fail {
  run(Scenario { ..default(), payments: [pay(wallet_with_stake(payee_b, stake_y), ada(3))] })
}

test d1_stake_credential_removed() fail {
  run(Scenario { ..default(), payments: [pay(wallet(payee_b), ada(3))] })
}

test d1_stake_credential_added() fail {
  run(Scenario { ..default(), payments: [pay(wallet_with_stake(payee_a, stake_x), ada(3))] })
}

test d1_pointer_stake_credential() fail {
  let ptr =
    Address {
      payment_credential: VerificationKey(payee_a),
      stake_credential: Some(Pointer { slot_number: 1, transaction_index: 0, certificate_index: 0 }),
    }
  run(Scenario { ..default(), payments: [pay(ptr, ada(3))] })
}

test d1_script_payment_with_allowed_hash() fail {
  // Same 28 bytes as an allowed key, but a script credential.
  let a = Address { payment_credential: Script(payee_a), stake_credential: None }
  run(Scenario { ..default(), payments: [pay(a, ada(3))] })
}

test d1_stranger() fail {
  run(Scenario { ..default(), payments: [pay(wallet(stranger), ada(3))] })
}

test d2_empty_allowlist_denies_even_fee_only() fail {
  let s = with_datum(fn(d) { AllowanceDatum { ..d, destinations: [] } })
  run(Scenario { ..s, payments: [] })
}

// ===========================================================================
// Config, pause, roles, signatures, intent

test d4_no_config_reference() fail {
  let s = default()
  run_tx(s, Transaction { ..build(s), reference_inputs: [] })
}

test d4_forged_config() fail {
  let s = default()
  let forged =
    Input {
      output_reference: out_ref(901),
      output: output(
        canonical_address(vault),
        assets.merge(ada(2), assets.from_asset(other_script, "config", 1)),
        cfg_2_of_3(),
      ),
    }
  run_tx(s, Transaction { ..build(s), reference_inputs: [forged] })
}

test pause_blocks_agent_spend() fail {
  run(Scenario { ..default(), cfg: ConfigDatum { ..cfg_2_of_3(), paused: True } })
}

test d6_agent_is_owner() fail {
  run(Scenario { ..default(), cfg: ConfigDatum { ..cfg_2_of_3(), owners: [owner_a, owner_b, agent_key] } })
}

test missing_agent_signature() fail {
  run(Scenario { ..default(), signers: [] })
}

test owner_signatures_never_substitute_for_agent() fail {
  run(Scenario { ..default(), signers: [owner_a, owner_b, owner_c] })
}

test intent_must_be_32_bytes() fail {
  let s = default()
  agent_spend(allowance_input(s), vault, #"1e1e", build(s))
}

test intent_empty_rejected() fail {
  let s = default()
  agent_spend(allowance_input(s), vault, #"", build(s))
}

// ===========================================================================
// Co-signed over-limit spends

fn co(s: Scenario) -> Bool {
  co_signed_spend(allowance_input(s), vault, intent, build(s))
}

fn over_limit() -> Scenario {
  Scenario { ..default(), payments: [pay(wallet(stranger), ada(90))], signers: [agent_key, owner_a, owner_c] }
}

test cosign_over_limit_ok() {
  co(over_limit())
}

test cosign_without_agent() fail {
  co(Scenario { ..over_limit(), signers: [owner_a, owner_c] })
}

test cosign_below_threshold() {
  !co(Scenario { ..over_limit(), signers: [agent_key, owner_a] })
}

test cosign_paused() fail {
  co(Scenario { ..over_limit(), cfg: ConfigDatum { ..cfg_2_of_3(), paused: True } })
}

test cosign_agent_is_owner() fail {
  co(Scenario { ..over_limit(), cfg: ConfigDatum { ..cfg_2_of_3(), owners: [owner_a, owner_c, agent_key] } })
}

test cosign_agent_signature_cannot_count_as_owner() {
  // agent + one owner: the agent's key is not an owner, so 1-of-2 only.
  !co(Scenario { ..over_limit(), signers: [agent_key, owner_b] })
}

test cosign_malformed_datum() fail {
  co(Scenario { ..over_limit(), input_datum: "garbage", typed: None })
}

test cosign_bad_intent() fail {
  let s = over_limit()
  co_signed_spend(allowance_input(s), vault, #"", build(s))
}

// ===========================================================================
// Added after mutation testing

test u3_config_nft_with_allowance_datum() fail {
  // Even if the config NFT sat next to a valid allowance datum, the agent
  // path refuses a UTxO whose vault token is the config NFT.
  let s =
    Scenario {
      ..default(),
      in_value: ada(100) |> assets.merge(usd(1000)) |> assets.merge(fixtures.config_nft()),
    }
  run(s)
}

test u4_capped_token_added_to_continuing_output() fail {
  // Not reachable under ledger value conservation, but checked anyway: a
  // negative delta on a capped asset must not shrink `spent`.
  let s = with_datum(fn(d) { AllowanceDatum { ..d, spent: [0, 900] } })
  let t = build(s)
  let cont = continuing_output(s)
  let d2 =
    AllowanceDatum { ..allowance_fixtures.base_datum(), spent: [5_300_000, 800] }
  let cont2 =
    Output {
      ..cont,
      value: assets.merge(cont.value, usd(100)),
      datum: InlineDatum(d2),
    }
  run_tx(s, Transaction { ..t, outputs: [cont2, ..s.payments] })
}

test cosign_well_typed_but_malformed_datum() {
  let s = over_limit()
  let bad = AllowanceDatum { ..allowance_fixtures.base_datum(), destinations: [] }
  !co(Scenario { ..s, input_datum: bad, typed: Some(bad) })
}
