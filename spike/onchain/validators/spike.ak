use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken_design_patterns/validity_range_normalization.{
  ClosedRange, normalize_time_range,
}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}

pub type SpikeDatum {
  agent: VerificationKeyHash,
  owners: List<VerificationKeyHash>,
  threshold: Int,
  counter: Int,
}

pub type SpikeRedeemer {
  // Agent alone: exactly one tx input, continuing output carries counter + 1,
  // and at most `cap` lovelace (payments + fee) may leave the script input.
  AgentStep { cap: Int }
  // Agent plus owner threshold over the same tx body.
  CoSigned
}

validator spike {
  spend(
    datum: Option<SpikeDatum>,
    redeemer: SpikeRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    expect list.has(self.extra_signatories, d.agent)
    expect ClosedRange { .. } = normalize_time_range(self.validity_range)
    when redeemer is {
      AgentStep { cap } -> {
        expect [own_input] = self.inputs
        expect own_input.output_reference == own_ref
        let own_address = own_input.output.address
        expect [continuing] =
          list.filter(self.outputs, fn(o) { o.address == own_address })
        expect InlineDatum(raw) = continuing.datum
        expect new_d: SpikeDatum = raw
        let left =
          assets.lovelace_of(own_input.output.value) - assets.lovelace_of(
            continuing.value,
          )
        and {
          new_d == SpikeDatum { ..d, counter: d.counter + 1 },
          left <= cap,
          left >= 0,
        }
      }
      CoSigned -> {
        let signed =
          list.count(d.owners, fn(k) { list.has(self.extra_signatories, k) })
        signed >= d.threshold
      }
    }
  }

  else(_) {
    fail
  }
}
