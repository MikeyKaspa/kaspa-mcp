import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = JSON.parse(readFileSync(join(root, "e2e-wallet.json"), "utf8")) as { privateKey: string };
const wallet = new Wallet(saved.privateKey);
console.log("address", wallet.address);

const chRes = await fetch("https://faucet.igralabs.com/api/testnet/challenge", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: wallet.address }),
});
const body = await chRes.json();
console.log("challenge", body);
const challenge = body.challenge as string;
const signature = await wallet.signMessage(challenge);

const payloads = [
  { address: wallet.address, signature, challenge },
  { address: wallet.address, signature, challenge, nonce: 0 },
];
for (const p of payloads) {
  const dripRes = await fetch("https://faucet.igralabs.com/api/testnet/drip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  console.log("drip", dripRes.status, await dripRes.text());
}
