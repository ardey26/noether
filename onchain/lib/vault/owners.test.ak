use aiken/collection/list
use aiken/fuzz
use vault/fixtures.{
  agent_key, cfg_2_of_3, key, owner_a, owner_b, owner_c, owner_d, stranger,
}
use vault/owners.{is_valid_config, threshold_met}
use vault/types.{ConfigDatum, max_owners}

// ---------------------------------------------------------------------------
// D5: invalid owner sets (unit)

test config_valid_2_of_3() {
  is_valid_config(cfg_2_of_3())
}

test config_rejects_threshold_zero() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), threshold: 0 })
}

test config_rejects_negative_threshold() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), threshold: -1 })
}

test config_rejects_threshold_above_owner_count() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), threshold: 4 })
}

test config_rejects_no_owners() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), owners: [], threshold: 0 })
}

test config_rejects_no_owners_even_with_threshold_one() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), owners: [], threshold: 1 })
}

test config_rejects_duplicate_owners() {
  // With duplicates, one key would count twice toward the threshold.
  !is_valid_config(
    ConfigDatum { ..cfg_2_of_3(), owners: [owner_a, owner_a, owner_b] },
  )
}

test config_rejects_too_many_owners() {
  let owners = list.indexed_map(list.repeat(0, max_owners + 1), fn(i, _) { key(i) })
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), owners: owners, threshold: 1 })
}

test config_accepts_max_owners() {
  let owners = list.indexed_map(list.repeat(0, max_owners), fn(i, _) { key(i) })
  is_valid_config(ConfigDatum { ..cfg_2_of_3(), owners: owners, threshold: 10 })
}

test config_rejects_short_key() {
  !is_valid_config(
    ConfigDatum {
      ..cfg_2_of_3(),
      owners: [owner_a, owner_b, #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"],
    },
  )
}

test config_rejects_zero_validity_window() {
  !is_valid_config(ConfigDatum { ..cfg_2_of_3(), max_tx_validity_ms: 0 })
}

// ---------------------------------------------------------------------------
// D5: invalid owner sets (property)

/// Distinct owners (0..12 of them) and any threshold in [-2, 14].
fn owner_set_and_threshold() -> Fuzzer<(List<ByteArray>, Int)> {
  fuzz.both(
    fuzz.set_between(fuzz.int_between(0, 255), 0, 12)
      |> fuzz.map(fn(ns) { list.map(ns, key) }),
    fuzz.int_between(-2, 14),
  )
}

test prop_config_validity_exact(
  (owners, threshold) via owner_set_and_threshold(),
) {
  let n = list.length(owners)
  let expected = and {
      n >= 1,
      n <= max_owners,
      threshold >= 1,
      threshold <= n,
    }
  is_valid_config(ConfigDatum { ..cfg_2_of_3(), owners: owners, threshold: threshold }) == expected
}

test prop_config_rejects_any_duplicate(
  (owners, dup) via fuzz.set_with_elem(fuzz.int_between(0, 255)),
) {
  let owners = list.map(owners, key)
  let with_dup = list.push(owners, key(dup))
  !is_valid_config(
    ConfigDatum { ..cfg_2_of_3(), owners: with_dup, threshold: 1 },
  )
}

// ---------------------------------------------------------------------------
// Threshold counting

test threshold_met_2_of_3() {
  threshold_met(cfg_2_of_3(), [owner_a, owner_c])
}

test threshold_not_met_1_of_3() {
  !threshold_met(cfg_2_of_3(), [owner_b])
}

test non_owner_signatures_do_not_count() {
  // An agent or stranger signature never counts toward the owner threshold.
  !threshold_met(cfg_2_of_3(), [owner_a, agent_key, stranger, owner_d])
}

/// For a set of owners, a random subset of signers drawn from owners and
/// strangers: the threshold is met exactly when enough *owners* signed.
test prop_threshold_counts_only_distinct_owners(
  (owner_ns, signer_ns, t) via fuzz.tuple3(
    fuzz.set_between(fuzz.int_between(0, 99), 1, 10),
    fuzz.set_between(fuzz.int_between(0, 199), 0, 20),
    fuzz.int_between(1, 10),
  ),
) {
  let owners = list.map(owner_ns, key)
  let signers = list.map(signer_ns, key)
  let t = if t > list.length(owners) { list.length(owners) } else { t }
  let cfg = ConfigDatum { ..cfg_2_of_3(), owners: owners, threshold: t }
  let owner_sigs = list.count(owners, fn(o) { list.has(signers, o) })
  threshold_met(cfg, signers) == ( owner_sigs >= t )
}

test repeated_signature_counts_once() {
  // The ledger already de-duplicates required signers; the count is per owner regardless.
  !threshold_met(cfg_2_of_3(), [owner_a, owner_a])
}
