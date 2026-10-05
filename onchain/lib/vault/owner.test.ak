use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{DatumHash, Input, Output, Transaction}
use vault/config.{canonical_address}
use vault/fixtures.{
  ada, agent_key, cfg_2_of_3, config_input, config_nft, config_output,
  other_script, out_ref, output, owner_a, owner_b, owner_c, owner_d,
  plain_output, script_address_with_stake, stranger, treasury_input, tx, vault,
  wallet, with_mint,
}
use vault/owner.{init_config, owner_manage}
use vault/types.{ConfigDatum, config_token_name}

// ---------------------------------------------------------------------------
// InitConfig (one-shot)

fn seed_input() -> Input {
  Input { output_reference: out_ref(0), output: plain_output(wallet(owner_a), ada(50)) }
}

fn init_tx(outputs: List<Output>) -> Transaction {
  tx([seed_input()], [], outputs, [])
    |> with_mint(config_nft())
}

test init_ok() {
  init_config(out_ref(0), vault, init_tx([config_output(cfg_2_of_3())]))
}

test init_fails_without_seed() fail {
  let t =
    tx([treasury_input(7, 50)], [], [config_output(cfg_2_of_3())], [])
      |> with_mint(config_nft())
  init_config(out_ref(0), vault, t)
}

test init_fails_minting_two_configs() fail {
  let t =
    init_tx([config_output(cfg_2_of_3())])
      |> with_mint(assets.from_asset(vault, config_token_name, 2))
  init_config(out_ref(0), vault, t)
}

test init_fails_minting_extra_token_under_policy() fail {
  // Edge U3: no allowance token can ride along with the config NFT.
  let t =
    init_tx([config_output(cfg_2_of_3())])
      |> with_mint(
          assets.merge(config_nft(), assets.from_asset(vault, "rogue", 1)),
        )
  init_config(out_ref(0), vault, t)
}

test init_fails_config_at_address_with_stake() {
  let o =
    Output {
      ..config_output(cfg_2_of_3()),
      address: script_address_with_stake(stranger),
    }
  !init_config(out_ref(0), vault, init_tx([o]))
}

test init_fails_config_at_other_script() {
  let o =
    Output {
      ..config_output(cfg_2_of_3()),
      address: Address {
        payment_credential: Script(other_script),
        stake_credential: None,
      },
    }
  !init_config(out_ref(0), vault, init_tx([o]))
}

test init_fails_datum_hash() {
  // Edge U5.
  let o = Output { ..config_output(cfg_2_of_3()), datum: DatumHash(#"00") }
  !init_config(out_ref(0), vault, init_tx([o]))
}

test init_fails_invalid_owner_set() {
  // Edge D5 at init.
  !init_config(
    out_ref(0),
    vault,
    init_tx([config_output(ConfigDatum { ..cfg_2_of_3(), threshold: 0 })]),
  )
}

test init_fails_garbage_datum() {
  let o =
    output(
      canonical_address(vault),
      assets.merge(ada(2), config_nft()),
      "not a config",
    )
  !init_config(out_ref(0), vault, init_tx([o]))
}

test init_fails_junk_token_in_config_output() {
  // Edge U4 for the config UTxO.
  let o =
    Output {
      ..config_output(cfg_2_of_3()),
      value: assets.merge(
        assets.merge(ada(2), config_nft()),
        assets.from_asset(other_script, "junk", 1),
      ),
    }
  !init_config(out_ref(0), vault, init_tx([o]))
}

test init_fails_ref_script_on_config_output() {
  let o = Output { ..config_output(cfg_2_of_3()), reference_script: Some(other_script) }
  !init_config(out_ref(0), vault, init_tx([o]))
}

// ---------------------------------------------------------------------------
// Config updates: rotation, threshold change, pause, unpause

fn update(next: ConfigDatum, signers: List<ByteArray>) -> Bool {
  let input = config_input(cfg_2_of_3())
  owner_manage(input, vault, tx([input], [], [config_output(next)], signers))
}

test rotate_owners_with_current_threshold() {
  update(
    ConfigDatum { ..cfg_2_of_3(), owners: [owner_b, owner_c, owner_d], threshold: 3 },
    [owner_a, owner_b],
  )
}

test rotation_needs_current_owners_not_new_ones() fail {
  // owner_d is only in the *new* set; one current owner is not enough.
  update(
    ConfigDatum { ..cfg_2_of_3(), owners: [owner_a, owner_d], threshold: 1 },
    [owner_a, owner_d],
  )
}

test pause_with_threshold() {
  update(ConfigDatum { ..cfg_2_of_3(), paused: True }, [owner_b, owner_c])
}

test pause_fails_below_threshold() fail {
  update(ConfigDatum { ..cfg_2_of_3(), paused: True }, [owner_b])
}

test unpause_requires_threshold() fail {
  let paused = ConfigDatum { ..cfg_2_of_3(), paused: True }
  let input = config_input(paused)
  owner_manage(input, vault, tx([input], [], [config_output(cfg_2_of_3())], [owner_a]))
}

test unpause_with_threshold() {
  let paused = ConfigDatum { ..cfg_2_of_3(), paused: True }
  let input = config_input(paused)
  owner_manage(
    input,
    vault,
    tx([input], [], [config_output(cfg_2_of_3())], [owner_a, owner_c]),
  )
}

test update_fails_with_agent_signature_standing_in_for_owner() fail {
  update(ConfigDatum { ..cfg_2_of_3(), paused: True }, [owner_a, agent_key])
}

test update_fails_to_invalid_owner_set() {
  !update(ConfigDatum { ..cfg_2_of_3(), threshold: 4 }, [owner_a, owner_b])
}

test update_fails_when_nft_leaves_vault() {
  let input = config_input(cfg_2_of_3())
  let moved =
    output(wallet(owner_a), assets.merge(ada(2), config_nft()), cfg_2_of_3())
  !owner_manage(input, vault, tx([input], [], [moved], [owner_a, owner_b]))
}

test update_fails_when_nft_disappears() fail {
  // No output holds the NFT (for example burned by another policy path).
  let input = config_input(cfg_2_of_3())
  owner_manage(
    input,
    vault,
    tx([input], [], [plain_output(wallet(owner_a), ada(2))], [owner_a, owner_b]),
  )
}

// ---------------------------------------------------------------------------
// Treasury and allowance UTxOs under OwnerManage

test treasury_spend_with_threshold() {
  let t =
    tx(
      [treasury_input(1, 100)],
      [config_input(cfg_2_of_3())],
      [plain_output(wallet(stranger), ada(99))],
      [owner_a, owner_b],
    )
  owner_manage(treasury_input(1, 100), vault, t)
}

test treasury_spend_fails_below_threshold() {
  let t =
    tx(
      [treasury_input(1, 100)],
      [config_input(cfg_2_of_3())],
      [plain_output(wallet(stranger), ada(99))],
      [owner_a, agent_key],
    )
  !owner_manage(treasury_input(1, 100), vault, t)
}

test treasury_spend_fails_without_config() fail {
  let t =
    tx(
      [treasury_input(1, 100)],
      [],
      [plain_output(wallet(stranger), ada(99))],
      [owner_a, owner_b],
    )
  owner_manage(treasury_input(1, 100), vault, t)
}

test treasury_spend_fails_with_forged_config_policy() fail {
  // Edge D4: a look-alike "config" token under another policy is ignored.
  let forged =
    Input {
      output_reference: out_ref(901),
      output: output(
        canonical_address(vault),
        assets.merge(ada(2), assets.from_asset(other_script, config_token_name, 1)),
        ConfigDatum { ..cfg_2_of_3(), owners: [stranger], threshold: 1 },
      ),
    }
  let t =
    tx([treasury_input(1, 100)], [forged], [plain_output(wallet(stranger), ada(99))], [stranger])
  owner_manage(treasury_input(1, 100), vault, t)
}

test treasury_spend_fails_with_config_nft_off_canonical_address() fail {
  // Defence in depth: even a real NFT is only trusted at the canonical address.
  let off =
    Input {
      output_reference: out_ref(902),
      output: Output {
        ..config_output(ConfigDatum { ..cfg_2_of_3(), owners: [stranger], threshold: 1 }),
        address: script_address_with_stake(stranger),
      },
    }
  let t =
    tx([treasury_input(1, 100)], [off], [plain_output(wallet(stranger), ada(99))], [stranger])
  owner_manage(treasury_input(1, 100), vault, t)
}

test treasury_and_config_in_same_tx_use_pre_update_owners() {
  // Rotating owners and moving treasury funds in one tx: the old owners'
  // threshold governs both inputs.
  let cfg_in = config_input(cfg_2_of_3())
  let next = ConfigDatum { ..cfg_2_of_3(), owners: [owner_d], threshold: 1 }
  let t =
    tx(
      [treasury_input(1, 100), cfg_in],
      [],
      [config_output(next), plain_output(wallet(owner_d), ada(99))],
      [owner_a, owner_b],
    )
  and {
    owner_manage(treasury_input(1, 100), vault, t),
    owner_manage(cfg_in, vault, t),
  }
}

test reclaim_corrupted_allowance_never_decodes_datum() {
  // Edge U6: an allowance UTxO whose datum is garbage is still reclaimable by
  // owner threshold + state token alone.
  let corrupted =
    Input {
      output_reference: out_ref(3),
      output: output(
        canonical_address(vault),
        assets.merge(ada(20), assets.from_asset(vault, #"abcd", 1)),
        "definitely not an AllowanceDatum",
      ),
    }
  let t =
    tx(
      [corrupted],
      [config_input(cfg_2_of_3())],
      [plain_output(wallet(owner_a), ada(19))],
      [owner_b, owner_c],
    )
      |> with_mint(assets.from_asset(vault, #"abcd", -1))
  owner_manage(corrupted, vault, t)
}

test reclaim_datum_hash_allowance() {
  // Edge U5 variant: a datum-by-hash allowance is still reclaimable.
  let hashed =
    Input {
      output_reference: out_ref(4),
      output: Output {
        address: canonical_address(vault),
        value: assets.merge(ada(20), assets.from_asset(vault, #"abcd", 1)),
        datum: DatumHash(#"ff"),
        reference_script: None,
      },
    }
  let t =
    tx(
      [hashed],
      [config_input(cfg_2_of_3())],
      [plain_output(wallet(owner_a), ada(19))],
      [owner_a, owner_c],
    )
  owner_manage(hashed, vault, t)
}

test owner_c_alone_cannot_reclaim() {
  let t =
    tx(
      [treasury_input(1, 100)],
      [config_input(cfg_2_of_3())],
      [plain_output(wallet(owner_c), ada(99))],
      [owner_c],
    )
  !owner_manage(treasury_input(1, 100), vault, t)
}
