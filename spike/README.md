# M0 spike: results

**Verdict: Lucid Evolution 0.6.5 passes both hard requirements.** It stays the off-chain SDK, and Blaze is not needed.

## Requirements
| Requirement | Result | Evidence |
|---|---|---|
| Fully manual input selection | Yes. `complete({ coinSelection: false })` builds a tx whose only input is the script UTxO. | The emulator and the Yaci node both show `inputs.length == 1` in the confirmed tx. |
| Explicit collateral | Yes, **through a workaround**. Lucid has no "use this UTxO as collateral" API. It picks collateral only from `presetWalletInputs`, so passing `[C]` forces collateral = C. | The body has `collateral_inputs == [C]` (emulator + Yaci). **The SDK must assert this after every build and fail closed.** |
| Fee paid from the script input, no change output | Yes. We choose the fee, set continuing = input − payments − fee, and `includeLeftoverLovelaceAsFee` burns the remainder. On-chain fee == our fee exactly. | Yaci: `fees == 600000`, 2 outputs |
| POSIX-ms validity | Yes. `validFrom`/`validTo` | Both |
| Multi-party witnesses on one body | Yes. `fromTx(cbor).partialSign.withPrivateKey` for each party, then `assemble([...])`. The body hash is unchanged. | Emulator: agent + 2-of-3 owners |
| Raw adversarial tx reaches the node | Yes. Mutate the CBOR after Lucid evaluates it, re-sign, then POST to the submit API. The node rejects it with `CekError` and the collateral is untouched. | Yaci |

## Findings to carry forward
1. **Ledger horizon.** An upper validity bound past the network's safe zone fails with `TimeTranslationPastHorizon` before any script runs.
   - The devnet safe zone is 300 slots; preprod's is about 36 h.
   - So `max_tx_validity_ms` must stay well under 36 h on preprod.
2. **Fee overpay.** A fixed fee guess (0.6 ADA vs about 0.2 ADA minimum) is charged against the cap. The SDK will build in two passes: read the minimum fee, then rebuild with a small margin.
3. **Indexer lag** (edge I6). `awaitTx` returns before the Yaci store indexes the tx. A follow-up query needs a short wait or a retry.
4. Yaci store's tx JSON uses `invalid`, where Blockfrost uses `valid_contract`. The SDK must not depend on that field.

## Run
```
# devnet: .tools/yaci/... (Docker) + create-node; see scripts/devnet.sh
cd spike/onchain && ../../.tools/aiken-aarch64-apple-darwin/aiken build
cd ../offchain && npx vitest run            # spike.test.ts = emulator, yaci.test.ts = devnet
```
