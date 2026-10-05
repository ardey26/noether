use cardano/assets
use cardano/transaction.{DatumHash, Input, NoDatum, Output, Transaction}
use vault/allowance.{allowance_name, manage_allowances}
use vault/allowance_fixtures.{base_datum}
use vault/config.{canonical_address}
use vault/fixtures.{
  ada, agent_key, cfg_2_of_3, config_input, other_script, out_ref, output,
  owner_a, owner_b, plain_output, script_address_with_stake, stranger, tx,
  vault, wallet, with_mint,
}
use vault/types.{config_token_name}

fn funding() -> Input {
  Input { output_reference: out_ref(30), output: plain_output(wallet(owner_a), ada(200)) }
}

fn name() -> ByteArray {
  allowance_name(out_ref(30))
}

fn allowance_out(n: ByteArray) -> Output {
  output(canonical_address(vault), assets.merge(ada(50), assets.from_asset(vault, n, 1)), base_datum())
}

fn create(outputs: List<Output>, mint: assets.Value, signers: List<ByteArray>) -> Bool {
  manage_allowances(
    vault,
    tx([funding()], [config_input(cfg_2_of_3())], outputs, signers) |> with_mint(mint),
  )
}

fn one(n: ByteArray) -> assets.Value {
  assets.from_asset(vault, n, 1)
}

test create_allowance_ok() {
  create([allowance_out(name())], one(name()), [owner_a, owner_b])
}

test create_two_allowances_from_two_seeds() {
  let second = Input { ..funding(), output_reference: out_ref(31) }
  let n2 = allowance_name(out_ref(31))
  manage_allowances(
    vault,
    tx([funding(), second], [config_input(cfg_2_of_3())], [allowance_out(name()), allowance_out(n2)], [owner_a, owner_b])
      |> with_mint(assets.merge(one(name()), one(n2))),
  )
}

test create_below_threshold() fail {
  create([allowance_out(name())], one(name()), [owner_a])
}

test create_by_agent_alone() fail {
  // Edge: only owners create allowances.
  create([allowance_out(name())], one(name()), [agent_key])
}

test create_without_config() fail {
  manage_allowances(
    vault,
    tx([funding()], [], [allowance_out(name())], [owner_a, owner_b]) |> with_mint(one(name())),
  )
}

test create_with_arbitrary_name() {
  // Names must be derived from a spent input: no chosen or duplicate names.
  !create([allowance_out("chosen")], one("chosen"), [owner_a, owner_b])
}

test create_with_name_from_unspent_ref() {
  let n = allowance_name(out_ref(99))
  !create([allowance_out(n)], one(n), [owner_a, owner_b])
}

test create_quantity_two() {
  let two = assets.from_asset(vault, name(), 2)
  let o = Output { ..allowance_out(name()), value: assets.merge(ada(50), two) }
  !create([o], two, [owner_a, owner_b])
}

test create_cannot_mint_config_nft() {
  // The config NFT is one-shot; ManageAllowances can never mint another.
  !create(
    [allowance_out(name())],
    assets.merge(one(name()), assets.from_asset(vault, config_token_name, 1)),
    [owner_a, owner_b],
  )
}

test cannot_burn_config_nft() {
  !create([], assets.from_asset(vault, config_token_name, -1), [owner_a, owner_b])
}

test create_output_off_canonical_address() {
  let o = Output { ..allowance_out(name()), address: script_address_with_stake(stranger) }
  !create([o], one(name()), [owner_a, owner_b])
}

test create_output_to_wallet() {
  // A token that leaked to a wallet could later fake an allowance.
  let o = Output { ..allowance_out(name()), address: wallet(owner_a) }
  !create([o], one(name()), [owner_a, owner_b])
}

test create_output_datum_hash() {
  let o = Output { ..allowance_out(name()), datum: DatumHash(#"aa") }
  !create([o], one(name()), [owner_a, owner_b])
}

test create_output_no_datum() {
  let o = Output { ..allowance_out(name()), datum: NoDatum }
  !create([o], one(name()), [owner_a, owner_b])
}

test create_output_with_ref_script() {
  let o = Output { ..allowance_out(name()), reference_script: Some(other_script) }
  !create([o], one(name()), [owner_a, owner_b])
}

test create_two_tokens_in_one_output() {
  let second = Input { ..funding(), output_reference: out_ref(31) }
  let n2 = allowance_name(out_ref(31))
  let o = Output { ..allowance_out(name()), value: assets.merge(allowance_out(name()).value, one(n2)) }
  !manage_allowances(
    vault,
    tx([funding(), second], [config_input(cfg_2_of_3())], [o], [owner_a, owner_b])
      |> with_mint(assets.merge(one(name()), one(n2))),
  )
}

test burn_allowance_with_threshold() {
  create([], assets.from_asset(vault, name(), -1), [owner_a, owner_b])
}

test burn_allowance_below_threshold() fail {
  create([], assets.from_asset(vault, name(), -1), [owner_b])
}

test burn_quantity_two() {
  !create([], assets.from_asset(vault, name(), -2), [owner_a, owner_b])
}

test manage_with_nothing_minted() fail {
  create([], assets.zero, [owner_a, owner_b])
}

test create_quantity_two_split_across_outputs() {
  // Two UTxOs sharing one allowance name would double the agent's cap.
  !create(
    [allowance_out(name()), allowance_out(name())],
    assets.from_asset(vault, name(), 2),
    [owner_a, owner_b],
  )
}
