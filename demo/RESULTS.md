# Preprod demo results

Run: 2026-10-05T13:14:23Z. Network: Preprod. Every link opens the tx on Cardanoscan.

| Step | Result |
|---|---|
| fund addr_test1vzk53dgfuh… with 20 tADA | [`d0fe1e58284fffa8…`](https://preprod.cardanoscan.io/transaction/d0fe1e58284fffa8303677b673afc4473f9d8d8750d5386b5be326ae22840ea8) |
| fund addr_test1vrdx44w3vu… with 10 tADA | [`4856d5bbb3a8d3c3…`](https://preprod.cardanoscan.io/transaction/4856d5bbb3a8d3c36b42b3ad37636cd5865a7a9e3d3ba0e5d26729012fc796d3) |
| create vault (config NFT + ref script) | [`346fba5d61155230…`](https://preprod.cardanoscan.io/transaction/346fba5d61155230068ed99a90c82a634522eb7f13d9233974c0385979097441) |
| fund treasury 150 tADA | [`ed4eecf3ab35352d…`](https://preprod.cardanoscan.io/transaction/ed4eecf3ab35352d5841ead5472e8884d4b23e6596d8685b2f39489628a34693) |
| grant allowance | [`0ddd5522b86f216e…`](https://preprod.cardanoscan.io/transaction/0ddd5522b86f216edb01a3f7749ba59c3161ad083a330fa05d78dc21eb1671c7) |
| agent pays merchant 4 tADA (intent INV-1001) | [`a67407cbf1351e61…`](https://preprod.cardanoscan.io/transaction/a67407cbf1351e610af84371ea29b8d0685e29a0ef3f23711d73950a4a21a805) |
| agent pays merchant 8 tADA (intent INV-1002) | [`d46e42d0f23779e2…`](https://preprod.cardanoscan.io/transaction/d46e42d0f23779e28d54a62fc65ac37ca23144d92440a45ecb324014c893a47e) |
| agent retries INV-1001 | already paid in `a67407cbf1351e61…` (found via journal); no second payment |
| agent pays merchant 9 tADA (window now ~22.1 of 25) | [`9e634f5327d43306…`](https://preprod.cardanoscan.io/transaction/9e634f5327d4330651dfb59dca1a4d92e1c03380878bc4ea3ad532f8ee1795c4) |
| agent tries 11 tADA (> 10 per tx) | blocked: `TX_CAP` (no tx; nothing left the vault) |
| agent tries 4 tADA (window would exceed 25) | blocked: `WINDOW_CAP` (no tx; nothing left the vault) |
| agent tries to pay contractor (not on allowlist) | blocked: `DESTINATION` (no tx; nothing left the vault) |
| bypass SDK preflight: 11 tADA, rejected by the validator script itself (node-level rejection: sdk/test/yaci) | blocked: `SCRIPT_OR_LEDGER` (no tx; nothing left the vault) |
| over-limit 30 tADA, agent + owners a,c in one tx | [`09e772d5f2ed0199…`](https://preprod.cardanoscan.io/transaction/09e772d5f2ed01997b3c9dd42a58def7f0d5c7e484308b2b77d787cda6081ee8) |
| pause (owners b,c) | [`acdee61b42fb2d17…`](https://preprod.cardanoscan.io/transaction/acdee61b42fb2d1761e7a441f002a474c032e2a213911f3faf56b95201b09f98) |
| agent spend while paused | blocked: `PAUSED` (no tx; nothing left the vault) |
| unpause (owners a,b) | [`43cc2fa64f9f89c7…`](https://preprod.cardanoscan.io/transaction/43cc2fa64f9f89c7491f0ac5e0a4668b1be05063f0b594c130b61de8a212346c) |
| revoke + reclaim (owners b,c) | [`520fff53771f064b…`](https://preprod.cardanoscan.io/transaction/520fff53771f064b07d1dd91e1b33a553af30bcc14ccb8a910f8afc95e4ae7c9) |
| grant a fresh allowance for the LLM agent | [`ca61952aec50836e…`](https://preprod.cardanoscan.io/transaction/ca61952aec50836e769dadbf172267a95b223362985b79f8052fc8a82ab40e49) |
| agent run 1: pay_invoice AP-1-10051314 | paid: [`923ec8df118b9079…`](https://preprod.cardanoscan.io/transaction/923ec8df118b9079519ccd7522b8a2775e25bb5896e04e6626edb3fea3d382e9) |
| agent run 1: pay_invoice AP-2-10051314 | blocked (TX_CAP) |
| agent run 1: pay_invoice AP-3-10051314 | blocked (DESTINATION) |
| agent run 1: pay_invoice AP-4-10051314 | blocked (DESTINATION) |
| agent run 1: request_owner_approval AP-2-10051314 | awaiting_owners |
| agent run 2: pay_invoice AP-1-10051314 | already-paid: [`923ec8df118b9079…`](https://preprod.cardanoscan.io/transaction/923ec8df118b9079519ccd7522b8a2775e25bb5896e04e6626edb3fea3d382e9) |
| agent run 2: pay_invoice AP-2-10051314 | blocked (TX_CAP) |
| agent run 2: pay_invoice AP-3-10051314 | blocked (DESTINATION) |
| agent run 2: pay_invoice AP-4-10051314 | blocked (DESTINATION) |
| agent run 2: request_owner_approval AP-2-10051314 | awaiting_owners |
| owners a+b co-sign the agent's escalation for AP-2 (15 tADA) | [`dfc7625f51ff7656…`](https://preprod.cardanoscan.io/transaction/dfc7625f51ff7656b1fd4dd58b7d52b04d442434d7965f85563397aad612b22f) |
| revoke the LLM agent's allowance | [`c06f59ab1247f034…`](https://preprod.cardanoscan.io/transaction/c06f59ab1247f03467b255b7d3163fce38cabb7825fb88b87b2e98d7ad1f8bc0) |
