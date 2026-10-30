import { ContractFactory, Interface, JsonRpcProvider, Wallet, formatEther } from "ethers";
import type { KaspaBackend } from "./types.js";
import type {
  BalanceResult,
  CallResult,
  CompileResult,
  DeployResult,
  NetworkInfo,
  PreparedTx,
  TxResult,
} from "../types.js";
import { SafetyError, assertCanSignWithKey } from "../safety.js";
import { compileSolidityAsync } from "./compile.js";

/** @deprecated Prefer compileSolidityAsync — kept as async alias for callers. */
export async function compileSolidity(
  source: string,
  options?: { contractName?: string },
): Promise<CompileResult> {
  return compileSolidityAsync(source, options);
}

function providerFor(network: NetworkInfo): JsonRpcProvider {
  if (!network.rpcUrl) throw new Error(`Network ${network.id} has no RPC URL`);
  return new JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true });
}

function explorerTx(network: NetworkInfo, hash: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined;
}
function explorerAddr(network: NetworkInfo, addr: string): string | undefined {
  return network.explorerUrl ? `${network.explorerUrl}/address/${addr}` : undefined;
}

export class EvmBackend implements KaspaBackend {
  readonly kind = "evm" as const;

  supports(network: NetworkInfo): boolean {
    return network.kind === "evm" && Boolean(network.rpcUrl);
  }

  async getBalance(network: NetworkInfo, address: string): Promise<BalanceResult> {
    const p = providerFor(network);
    const wei = await p.getBalance(address);
    return {
      address,
      balanceWei: wei.toString(),
      balanceFormatted: formatEther(wei),
      symbol: network.nativeCurrency.symbol,
      networkId: network.id,
    };
  }

  async getTx(network: NetworkInfo, hash: string): Promise<TxResult> {
    const p = providerFor(network);
    const tx = await p.getTransaction(hash);
    const receipt = await p.getTransactionReceipt(hash);
    let status: TxResult["status"] = "unknown";
    if (!tx) status = "unknown";
    else if (!receipt) status = "pending";
    else status = receipt.status === 1 ? "success" : "reverted";
    return {
      hash,
      status,
      blockNumber: receipt?.blockNumber,
      from: tx?.from,
      to: tx?.to ?? undefined,
      contractAddress: receipt?.contractAddress ?? undefined,
      explorerUrl: explorerTx(network, hash),
      networkId: network.id,
      raw: { tx, receipt },
    };
  }

  async compile(
    _network: NetworkInfo,
    source: string,
    options?: { contractName?: string },
  ): Promise<CompileResult> {
    return compileSolidityAsync(source, options);
  }

  private async buildDeployTx(
    network: NetworkInfo,
    compiled: CompileResult,
    ctorArgs: unknown[] = [],
    fromAddress?: string,
  ): Promise<{
    data: string;
    gasLimit: bigint;
    gasPrice: bigint;
    nonce?: number;
    factory: ContractFactory;
  }> {
    const p = providerFor(network);
    const factory = new ContractFactory(compiled.abi as never, compiled.bytecode, p);
    const txReq = await factory.getDeployTransaction(...ctorArgs);
    const from = fromAddress ?? "0x0000000000000000000000000000000000000001";
    const gasLimit = await p.estimateGas({ ...txReq, from });
    const fee = await p.getFeeData();
    const min = network.minGasPriceWei ? BigInt(network.minGasPriceWei) : 0n;
    const gasPrice = fee.gasPrice && fee.gasPrice > min ? fee.gasPrice : min || 1_000_000_000n;
    const nonce = fromAddress ? await p.getTransactionCount(fromAddress) : undefined;
    return { data: txReq.data ?? "0x", gasLimit, gasPrice, nonce, factory };
  }

  async prepareDeploy(
    network: NetworkInfo,
    compiled: CompileResult,
    ctorArgs: unknown[] = [],
    fromAddress?: string,
  ): Promise<PreparedTx> {
    const built = await this.buildDeployTx(network, compiled, ctorArgs, fromAddress);
    return {
      mode: "unsigned",
      networkId: network.id,
      to: null,
      data: built.data,
      value: "0",
      gasLimit: built.gasLimit.toString(),
      gasPrice: built.gasPrice.toString(),
      nonce: built.nonce,
      chainId: network.chainId,
      summary: `Unsigned deploy of ${compiled.contractName} on ${network.id}. Sign with your wallet, then send_raw_transaction.`,
    };
  }

  async deploy(
    network: NetworkInfo,
    compiled: CompileResult,
    options: { ctorArgs?: unknown[]; privateKey?: string; signedRawTx?: string },
  ): Promise<DeployResult> {
    const p = providerFor(network);

    if (options.signedRawTx) {
      const resp = await p.broadcastTransaction(options.signedRawTx);
      const receipt = await resp.wait();
      const addr = receipt?.contractAddress ?? undefined;
      return {
        txHash: resp.hash,
        contractAddress: addr,
        explorerTxUrl: explorerTx(network, resp.hash),
        explorerAddressUrl: addr ? explorerAddr(network, addr) : undefined,
        networkId: network.id,
      };
    }

    assertCanSignWithKey(network, options.privateKey);
    if (!options.privateKey) {
      throw new SafetyError(
        "deploy requires testnet privateKey (ephemeral) or signedRawTx. On mainnet use prepare_deploy.",
      );
    }

    const wallet = new Wallet(options.privateKey, p);
    const factory = new ContractFactory(compiled.abi as never, compiled.bytecode, wallet);
    const fee = await p.getFeeData();
    const min = network.minGasPriceWei ? BigInt(network.minGasPriceWei) : 0n;
    const gasPrice = fee.gasPrice && fee.gasPrice > min ? fee.gasPrice : min || 1_000_000_000n;
    const contract = await factory.deploy(...(options.ctorArgs ?? []), {
      gasPrice,
      type: 0, // legacy — recommended on Igra; fine on Kasplex
    });
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    const tx = contract.deploymentTransaction();
    const hash = tx?.hash ?? "";
    return {
      txHash: hash,
      contractAddress: addr,
      explorerTxUrl: hash ? explorerTx(network, hash) : undefined,
      explorerAddressUrl: explorerAddr(network, addr),
      networkId: network.id,
    };
  }

  async readContract(
    network: NetworkInfo,
    address: string,
    abi: unknown[],
    functionName: string,
    args: unknown[] = [],
  ): Promise<CallResult> {
    const p = providerFor(network);
    const iface = new Interface(abi as never);
    const data = iface.encodeFunctionData(functionName, args);
    const raw = await p.call({ to: address, data });
    let decoded: unknown;
    try {
      const r = iface.decodeFunctionResult(functionName, raw);
      decoded = r.length === 1 ? r[0] : Array.from(r);
      if (typeof decoded === "bigint") decoded = decoded.toString();
      else if (Array.isArray(decoded)) {
        decoded = decoded.map((x) => (typeof x === "bigint" ? x.toString() : x));
      }
    } catch {
      decoded = undefined;
    }
    return { raw, decoded, networkId: network.id };
  }

  async prepareCall(
    network: NetworkInfo,
    address: string,
    abi: unknown[],
    functionName: string,
    args: unknown[] = [],
    valueWei = "0",
    fromAddress?: string,
  ): Promise<PreparedTx> {
    const p = providerFor(network);
    const iface = new Interface(abi as never);
    const data = iface.encodeFunctionData(functionName, args);
    const from = fromAddress ?? "0x0000000000000000000000000000000000000001";
    const gasLimit = await p.estimateGas({ to: address, data, value: BigInt(valueWei), from });
    const fee = await p.getFeeData();
    const min = network.minGasPriceWei ? BigInt(network.minGasPriceWei) : 0n;
    const gasPrice = fee.gasPrice && fee.gasPrice > min ? fee.gasPrice : min || 1_000_000_000n;
    const nonce = fromAddress ? await p.getTransactionCount(fromAddress) : undefined;
    return {
      mode: "unsigned",
      networkId: network.id,
      to: address,
      data,
      value: valueWei,
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      nonce,
      chainId: network.chainId,
      summary: `Unsigned call ${functionName} on ${address} (${network.id}).`,
    };
  }

  async sendRawTransaction(network: NetworkInfo, rawTx: string): Promise<TxResult> {
    const p = providerFor(network);
    const resp = await p.broadcastTransaction(rawTx);
    return {
      hash: resp.hash,
      status: "pending",
      explorerUrl: explorerTx(network, resp.hash),
      networkId: network.id,
    };
  }
}
