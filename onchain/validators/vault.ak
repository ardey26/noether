use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/assets
use cardano/address.{Script}
use cardano/transaction.{Input, OutputReference, Transaction, find_input}
use vault/allowance_fixtures as afx
use vault/fixtures
use vault/allowance
use vault/owner
use vault/types.{
  AgentSpend, AllowanceDatum, AssetCap, CoSignedSpend, ConfigDatum, InitConfig,
  ManageAllowances, MintRedeemer, OwnerManage, SpendRedeemer, max_assets,
  max_destinations, max_owners,
}

/// The vault. Parameterised only by a seed UTxO, so its hash (the spend
/// address and the token policy) never changes when owners rotate.
validator vault(seed: OutputReference) {
  spend(
    _datum: Option<Data>,
    redeemer: SpendRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(own_input) = find_input(tx.inputs, own_ref)
    expect Script(vault_hash) = own_input.output.address.payment_credential
    when redeemer is {
      OwnerManage -> owner.owner_manage(own_input, vault_hash, tx)
      AgentSpend { intent_hash } ->
        allowance.agent_spend(own_input, vault_hash, intent_hash, tx)
      CoSignedSpend { intent_hash } ->
        allowance.co_signed_spend(own_input, vault_hash, intent_hash, tx)
    }
  }

  mint(redeemer: MintRedeemer, policy: ScriptHash, tx: Transaction) {
    when redeemer is {
      InitConfig -> owner.init_config(seed, policy, tx)
      ManageAllowances -> allowance.manage_allowances(policy, tx)
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Wiring tests through the compiled entry points. Logic is tested in lib/.


test wiring_owner_manage_treasury() {
  let t =
    fixtures.tx(
      [fixtures.treasury_input(1, 100)],
      [fixtures.config_input(fixtures.cfg_2_of_3())],
      [],
      [fixtures.owner_a, fixtures.owner_b],
    )
  vault.spend(fixtures.out_ref(0), None, OwnerManage, fixtures.out_ref(1), t)
}

test wiring_spend_fails_for_unknown_own_ref() fail {
  let t =
    fixtures.tx(
      [fixtures.treasury_input(1, 100)],
      [fixtures.config_input(fixtures.cfg_2_of_3())],
      [],
      [fixtures.owner_a, fixtures.owner_b],
    )
  vault.spend(fixtures.out_ref(0), None, OwnerManage, fixtures.out_ref(42), t)
}

test wiring_owner_manage_below_threshold() {
  let t =
    fixtures.tx(
      [fixtures.treasury_input(1, 100)],
      [fixtures.config_input(fixtures.cfg_2_of_3())],
      [],
      [fixtures.owner_a],
    )
  !vault.spend(fixtures.out_ref(0), None, OwnerManage, fixtures.out_ref(1), t)
}

test wiring_agent_spend_rejects_treasury_utxo() fail {
  // A treasury UTxO (no allowance token) cannot be spent on the agent path.
  let t =
    fixtures.tx(
      [fixtures.treasury_input(1, 100)],
      [fixtures.config_input(fixtures.cfg_2_of_3())],
      [],
      [fixtures.agent_key],
    )
  vault.spend(fixtures.out_ref(0), None, AgentSpend { intent_hash: afx.intent }, fixtures.out_ref(1), t)
}

test wiring_cosigned_rejects_treasury_utxo() fail {
  let t =
    fixtures.tx(
      [fixtures.treasury_input(1, 100)],
      [fixtures.config_input(fixtures.cfg_2_of_3())],
      [],
      [fixtures.agent_key, fixtures.owner_a, fixtures.owner_b],
    )
  vault.spend(fixtures.out_ref(0), None, CoSignedSpend { intent_hash: afx.intent }, fixtures.out_ref(1), t)
}

test wiring_manage_allowances_below_threshold() fail {
  let t =
    fixtures.tx([], [fixtures.config_input(fixtures.cfg_2_of_3())], [], [fixtures.owner_a])
      |> fixtures.with_mint(assets.from_asset(fixtures.vault, afx.token(), -1))
  vault.mint(fixtures.out_ref(0), ManageAllowances, fixtures.vault, t)
}

test wiring_init_config() {
  let seed =
    Input {
      output_reference: fixtures.out_ref(0),
      output: fixtures.plain_output(fixtures.wallet(fixtures.owner_a), fixtures.ada(5)),
    }
  let t =
    fixtures.tx([seed], [], [fixtures.config_output(fixtures.cfg_2_of_3())], [])
      |> fixtures.with_mint(fixtures.config_nft())
  vault.mint(fixtures.out_ref(0), InitConfig, fixtures.vault, t)
}

test wiring_init_config_wrong_seed() fail {
  let seed =
    Input {
      output_reference: fixtures.out_ref(5),
      output: fixtures.plain_output(fixtures.wallet(fixtures.owner_a), fixtures.ada(5)),
    }
  let t =
    fixtures.tx([seed], [], [fixtures.config_output(fixtures.cfg_2_of_3())], [])
      |> fixtures.with_mint(fixtures.config_nft())
  vault.mint(fixtures.out_ref(0), InitConfig, fixtures.vault, t)
}

// ---------------------------------------------------------------------------
// Budget benchmarks at maximum datum sizes (edge D3). The measured units
// include building the test tx, so they over-estimate the on-chain cost.
// scripts/budget.sh asserts each stays under 50% of the per-tx limit.

fn max_config() -> ConfigDatum {
  ConfigDatum {
    ..fixtures.cfg_2_of_3(),
    owners: list.indexed_map(list.repeat(0, max_owners), fn(i, _) { fixtures.key(i) }),
    threshold: max_owners,
  }
}

fn max_scenario() -> afx.Scenario {
  let policies = list.indexed_map(list.repeat(0, max_assets - 1), fn(i, _) { fixtures.key(100 + i) })
  let caps =
    [
      afx.lovelace_cap(1_000_000_000, 1_000_000_000),
      ..list.map(policies, fn(p) { AssetCap { policy: p, name: "T", window_cap: 1_000_000, tx_cap: 1_000_000 } })
    ]
  let dests =
    list.indexed_map(
      list.repeat(0, max_destinations),
      fn(i, _) { fixtures.wallet_with_stake(fixtures.key(200 + i), fixtures.key(230 + i)) },
    )
  let tokens = list.foldl(policies, assets.zero, fn(p, acc) { assets.merge(acc, assets.from_asset(p, "T", 1000)) })
  let per_payment =
    list.foldl(policies, fixtures.ada(2), fn(p, acc) { assets.merge(acc, assets.from_asset(p, "T", 1)) })
  let d =
    AllowanceDatum {
      ..afx.base_datum(),
      destinations: dests,
      caps: caps,
      spent: list.repeat(0, max_assets),
    }
  // Every payment goes to the *last* destination: worst case for list.has.
  let last = list.foldl(dests, fixtures.wallet(fixtures.stranger), fn(a, _) { a })
  afx.Scenario {
    ..afx.scenario(d),
    cfg: max_config(),
    in_value: fixtures.ada(500)
      |> assets.merge(tokens)
      |> assets.merge(assets.from_asset(fixtures.vault, afx.token(), 1)),
    payments: list.repeat(afx.pay(last, per_payment), max_destinations),
  }
}

test bench_agent_spend_max_sizes() {
  let s = max_scenario()
  vault.spend(fixtures.out_ref(0), None, AgentSpend { intent_hash: afx.intent }, fixtures.out_ref(10), afx.build(s))
}

test bench_cosigned_spend_max_sizes() {
  let s = afx.Scenario { ..max_scenario(), signers: [fixtures.agent_key, ..max_config().owners] }
  vault.spend(fixtures.out_ref(0), None, CoSignedSpend { intent_hash: afx.intent }, fixtures.out_ref(10), afx.build(s))
}

test bench_owner_reclaim_max_config() {
  let s = afx.Scenario { ..max_scenario(), signers: max_config().owners }
  vault.spend(fixtures.out_ref(0), None, OwnerManage, fixtures.out_ref(10), afx.build(s))
}
