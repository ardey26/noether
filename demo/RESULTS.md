# Preprod demo results

Run: 2026-10-05T09:50:17Z. Network: Preprod. Every link opens the tx on Cardanoscan.

| Step | Result |
|---|---|
| fund addr_test1vzk53dgfuh… with 20 tADA | [`98520b33aae786b3…`](https://preprod.cardanoscan.io/transaction/98520b33aae786b33b66f66de3b90eac1392c9ec153c55683666a250fc54f871) |
| fund addr_test1vrdx44w3vu… with 10 tADA | [`cb5c178615961e4a…`](https://preprod.cardanoscan.io/transaction/cb5c178615961e4a49c7af375547656f02ac5eebce3ffe8b778d126e95897e6e) |
| create vault (config NFT + ref script) | [`6e9454d061fcce5c…`](https://preprod.cardanoscan.io/transaction/6e9454d061fcce5c4bf4153a0f04e381e12e0efd667c3298c62dc762c59129fe) |
| fund treasury 150 tADA | [`0c07167e5ebe73e6…`](https://preprod.cardanoscan.io/transaction/0c07167e5ebe73e688269bd7e02cfe47681b5843534028baa89f695e3b55dd66) |
| grant allowance | [`1e07a5f3bf6dd00f…`](https://preprod.cardanoscan.io/transaction/1e07a5f3bf6dd00fe9d667c6c17a150dafd632f78f1abd3b3431d2699ac4ab8c) |
| agent pays merchant 4 tADA (intent INV-1001) | [`fa2dd277fc75040c…`](https://preprod.cardanoscan.io/transaction/fa2dd277fc75040c0bfd00dc11d9d7a44020308251c124bdf941d2bbdfa443f2) |
| agent pays merchant 8 tADA (intent INV-1002) | [`e6961b4859a14dff…`](https://preprod.cardanoscan.io/transaction/e6961b4859a14dff6a21e80f568b292b94f144d118955c930b3679f855bf0dd8) |
| agent pays merchant 9 tADA (window now ~22.1 of 25) | [`09627ee449fbfc29…`](https://preprod.cardanoscan.io/transaction/09627ee449fbfc299350d16700bad38e6bb577cf34925e57579c51a6ec2c9bed) |
| agent tries 11 tADA (> 10 per tx) | blocked: `TX_CAP` (no tx; nothing left the vault) |
| agent tries 4 tADA (window would exceed 25) | blocked: `WINDOW_CAP` (no tx; nothing left the vault) |
| agent tries to pay contractor (not on allowlist) | blocked: `DESTINATION` (no tx; nothing left the vault) |
| bypass SDK preflight: 11 tADA, rejected by the validator script itself (node-level rejection: sdk/test/yaci) | blocked: `SCRIPT_OR_LEDGER` (no tx; nothing left the vault) |
| over-limit 30 tADA, agent + owners a,c in one tx | [`8bd552335e730e0c…`](https://preprod.cardanoscan.io/transaction/8bd552335e730e0c35ed51506f49f44d31e71b64819ef749d9cff7824f660f19) |
| pause (owners b,c) | [`28305f931f09ce25…`](https://preprod.cardanoscan.io/transaction/28305f931f09ce254372f90658cebbc339abd96546faa48d03c2bd761ac481a6) |
| agent spend while paused | blocked: `PAUSED` (no tx; nothing left the vault) |
| unpause (owners a,b) | [`32322babdd454a31…`](https://preprod.cardanoscan.io/transaction/32322babdd454a3185864d3bd5911dbeb17b3cfe3e3f711b194c0da6d40342ee) |
| revoke + reclaim (owners b,c) | [`4ccc40e7bd8826aa…`](https://preprod.cardanoscan.io/transaction/4ccc40e7bd8826aaad0d8345891f2a43633762ecc1e5b9e5500a09ef7520a041) |
