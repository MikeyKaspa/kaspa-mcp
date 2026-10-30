/**
 * End-to-end TESTNET proof on Kasplex.
 * - Generates a throwaway key (printed address only; key written to gitignored file with 0600)
 * - Attempts faucet (reports if captcha / unreachable)
 * - Compiles Counter.sol, deploys if funded, calls increment + value()
 *
 * NEVER uses mainnet. NEVER spends real money.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, JsonRpcProvider, Contract } from "ethers";
import { compileSolidityAsync as compileSolidity } from "../src/backends/compile.js";
import { EvmBackend } from "../src/backends/evm.js";
import { getNetwork } from "../src/networks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const walletPath = join(root, "e2e-wallet.json");
const network = getNetwork("kasplex-testnet");
const backend = new EvmBackend();

function loadOrCreateWallet(): Wallet {
  if (existsSync(walletPath)) {
    const saved = JSON.parse(readFileSync(walletPath, "utf8")) as { privateKey: string };
    return new Wallet(saved.privateKey);
  }
  const w = Wallet.createRandom();
  writeFileSync(
    walletPath,
    JSON.stringify({ address: w.address, privateKey: w.privateKey, note: "TESTNET THROWAY — do not reuse on mainnet" }, null, 2),
    { mode: 0o600 },
  );
  return w;
}

async function main() {
  console.log("=== kaspa-mcp e2e (Kasplex testnet only) ===");
  console.log("RPC", network.rpcUrl);

  // verify RPC
  const prov = new JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true });
  const chainId = (await prov.getNetwork()).chainId;
  console.log("chainId", chainId.toString(), chainId === BigInt(network.chainId!) ? "OK" : "MISMATCH");

  const wallet = loadOrCreateWallet();
  console.log("throwaway address", wallet.address);
  console.log("(private key stored only in gitignored e2e-wallet.json — not printed)");

  const bal = await backend.getBalance(network, wallet.address);
  console.log("balance", bal.balanceFormatted, bal.symbol);

  if (BigInt(bal.balanceWei) === 0n) {
    console.log("\nFAUCET REQUIRED — balance is 0");
    console.log("Official faucet:", network.faucetUrl);
    console.log("Notes:", network.faucetNotes);
    console.log(
      "This script will NOT solve captchas. Claim free testnet KAS to the address above, then re-run: npm run e2e:testnet",
    );

    // Still prove compile + prepareDeploy without broadcasting
    const source = readFileSync(join(root, "examples/Counter.sol"), "utf8");
    const compiled = await compileSolidity(source, { contractName: "Counter" });
    console.log("\ncompile OK", compiled.contractName, "bytecode bytes", (compiled.bytecode.length - 2) / 2);
    const prepared = await backend.prepareDeploy(network, compiled, [0], wallet.address);
    console.log("prepare_deploy OK", {
      gasLimit: prepared.gasLimit,
      gasPrice: prepared.gasPrice,
      dataLen: prepared.data.length,
      chainId: prepared.chainId,
    });
    console.log("\nBLOCKED: deploy until faucet funds arrive (free, captcha/web).");
    process.exit(2);
  }

  const source = readFileSync(join(root, "examples/Counter.sol"), "utf8");
  const compiled = await compileSolidity(source, { contractName: "Counter" });
  console.log("compile OK", compiled.compiler);

  console.log("deploying Counter(0)...");
  const deployed = await backend.deploy(network, compiled, {
    ctorArgs: [0],
    privateKey: wallet.privateKey,
  });
  console.log("DEPLOYED", deployed);

  const abi = compiled.abi;
  const read1 = await backend.readContract(network, deployed.contractAddress!, abi, "value", []);
  console.log("value() before", read1.decoded);

  // call increment with testnet key via prepare+sign manually through Contract
  const c = new Contract(deployed.contractAddress!, abi as never, wallet.connect(prov));
  const min = BigInt(network.minGasPriceWei ?? "0");
  const tx = await c.increment({ gasPrice: min, type: 0 });
  console.log("increment tx", tx.hash);
  await tx.wait();
  const read2 = await backend.readContract(network, deployed.contractAddress!, abi, "value", []);
  console.log("value() after", read2.decoded);

  console.log("\n=== SUCCESS ===");
  console.log("explorer tx", deployed.explorerTxUrl);
  console.log("explorer contract", deployed.explorerAddressUrl);
}

main().catch((e) => {
  console.error("e2e failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
