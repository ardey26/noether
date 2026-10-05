// Plain ADA transfer from a local key (demo setup only): transfer.mts <fromKey> <toAddress> <ada>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { awaitSettled, connect, providerFromEnv } from "../sdk/src/index.js";

const [from, to, amount] = process.argv.slice(2);
const home = process.env.VAULT_HOME ?? ".vault";
const lucid = await connect(providerFromEnv());
lucid.selectWallet.fromPrivateKey(readFileSync(join(home, "keys", `${from}.sk`), "utf8").trim());
const tx = await lucid.newTx().pay.ToAddress(to!, { lovelace: BigInt(Math.round(Number(amount) * 1e6)) }).complete();
const signed = await tx.sign.withWallet().complete();
await signed.submit();
const hash = await awaitSettled(lucid, signed.toCBOR());
console.log(JSON.stringify({ submitted: hash }));
