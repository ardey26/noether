use cardano/script_context.{Minting, ScriptContext}
use cardano/transaction.{placeholder}

/// Always fails. The vault's reference script is parked here so that nobody,
/// owners included, can ever spend or remove it (edge I3).
validator ref_holder {
  else(_) {
    fail
  }
}

test ref_holder_rejects_everything() fail {
  ref_holder.else(
    ScriptContext { transaction: placeholder, redeemer: Void, info: Minting(#"") },
  )
}
