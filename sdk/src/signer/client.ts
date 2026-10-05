import { request } from "node:http";

function once(socketPath: string, txCbor: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/sign", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (res.statusCode === 200 && body.witness) resolve(body.witness);
        else reject(new Error(`signer refused: ${body.error ?? res.statusCode}`));
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ txCbor }));
  });
}

/**
 * Ask the signer daemon for a witness. Throws with the daemon's refusal reason.
 * A dropped connection (e.g. a reused socket after a daemon restart) is retried
 * once: safe, because re-signing the same body is idempotent at the signer.
 */
export async function requestWitness(socketPath: string, txCbor: string): Promise<string> {
  try {
    return await once(socketPath, txCbor);
  } catch (e) {
    if (!/EPIPE|ECONNRESET/.test(String((e as Error).message))) throw e;
    return once(socketPath, txCbor);
  }
}
