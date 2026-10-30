/** Claim Igra Galleon testnet faucet (official API, PoW + EIP-191). Free. Does not print the key. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = JSON.parse(readFileSync(join(root, "e2e-wallet.json"), "utf8")) as { privateKey: string; address: string };
const wallet = new Wallet(saved.privateKey);
console.log("address", wallet.address);

const status = await (await fetch("https://faucet.igralabs.com/api/testnet/status")).json();
console.log("faucet status", status);

const chRes = await fetch("https://faucet.igralabs.com/api/testnet/challenge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: wallet.address }),
});
const challengeBody = await chRes.json();
console.log("challenge response keys", Object.keys(challengeBody));
console.log("challenge body", JSON.stringify(challengeBody).slice(0, 500));

const challenge: string = challengeBody.challenge ?? challengeBody.message ?? challengeBody.data?.challenge;
const prefix: string = challengeBody.prefix ?? challengeBody.powPrefix ?? challengeBody.data?.prefix ?? challenge;
const difficulty: number = challengeBody.difficulty ?? challengeBody.bits ?? challengeBody.data?.difficulty ?? 20;

if (!challenge) {
  console.error("Unexpected challenge shape; cannot drip.");
  process.exit(1);
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let i = 7; i >= 0; i--) {
      if ((byte >> i) & 1) return bits;
      bits++;
    }
    break;
  }
  return bits;
}

let nonce = 0;
const start = Date.now();
while (true) {
  const h = createHash("sha256").update(`${prefix}:${nonce}`).digest();
  if (leadingZeroBits(h) >= difficulty) break;
  nonce++;
  if (nonce % 500000 === 0) console.log("pow progress", nonce, "ms", Date.now() - start);
}
console.log("pow solved nonce", nonce, "in", Date.now() - start, "ms");

const signature = await wallet.signMessage(challenge);
const dripRes = await fetch("https://faucet.igralabs.com/api/testnet/drip", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: wallet.address, signature, challenge, nonce }),
});
const dripText = await dripRes.text();
console.log("drip HTTP", dripRes.status, dripText.slice(0, 800));
