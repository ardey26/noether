import { request } from "node:http";

/** Ask the signer daemon for a witness. Throws with the daemon's refusal reason. */
export function requestWitness(socketPath: string, txCbor: string): Promise<string> {
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
