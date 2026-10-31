/**
 * Quick-start wallet — keys created & stored ONLY in the browser.
 * Prefer WebAuthn passkey PRF → AES-GCM; fallback device PIN (PBKDF2).
 * Never posts keys to the server. Clearing site data loses the wallet unless exported.
 */
import init, {
  PrivateKey,
  Mnemonic,
  XPrv,
  PublicKeyGenerator,
  createTransactions,
  Transaction,
  createInputSignature,
  SighashType,
  RpcClient,
  Encoding,
  payToAddressScript,
} from "/kaspa-wasm/kaspa.js";

const KASPA_WASM_URL = "/kaspa-wasm/kaspa_bg.wasm";
const KASPA_WASM_SHA384_HEX =
  "a9b6999d892c9ddde2fb4283f547c8f141322ed6940e182e26fefe9b50c57f168ab58e2ed26679bdb0978798bd5f9d4e";

const DB_NAME = "kaspa-mcp-quick-wallet";
const STORE = "wallets";
const CAP_SOMPI = 50n * 100_000_000n;
const PBKDF2_ITERS = 210_000;
const SALT_LEN = 16;
const IV_LEN = 12;
const TN10_FAUCET = "https://faucet-tn10.kaspanet.io/";
const RP_NAME = "Kaspa MCP Quick-start";

let wasmReady;
let unlocked = null; // { id, network, address, xonlyHex, privateKeyHex, mnemonic? }

async function sha384Hex(buf) {
  const dig = await crypto.subtle.digest("SHA-384", buf);
  return Array.from(new Uint8Array(dig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function ensureKaspa() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const res = await fetch(KASPA_WASM_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("Failed to load kaspa-wasm (" + res.status + ")");
      const buf = await res.arrayBuffer();
      const got = await sha384Hex(buf);
      if (got !== KASPA_WASM_SHA384_HEX) {
        throw new Error("kaspa-wasm integrity check failed — refuse to run quick-start wallet.");
      }
      await init({ module_or_path: buf });
    })();
  }
  await wasmReady;
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function formatKas(sompi) {
  const n = BigInt(sompi);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? whole + "." + frac : String(whole);
}

export function parseKasToSompi(raw) {
  const t = String(raw).trim();
  if (!t) throw new Error("Enter an amount");
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error("Amount must look like 1.5 (max 8 decimals)");
  const [w, f = ""] = t.split(".");
  const frac = (f + "00000000").slice(0, 8);
  return BigInt(w) * 100000000n + BigInt(frac);
}

export function assertAddressNetwork(address, network) {
  const a = String(address).trim().toLowerCase();
  if (network === "testnet-10") {
    if (!a.startsWith("kaspatest:")) {
      throw new Error('Wrong network: need a testnet address starting with "kaspatest:"');
    }
    return;
  }
  if (!a.startsWith("kaspa:") || a.startsWith("kaspatest:") || a.startsWith("kaspasim:")) {
    throw new Error('Wrong network: need a mainnet address starting with "kaspa:"');
  }
}

export function assertCap(sompi) {
  if (BigInt(sompi) > CAP_SOMPI) {
    throw new Error(
      "Quick-start wallet hard cap is 50 KAS. Use KasWare/Kastle for larger amounts.",
    );
  }
}

export function getCapSompi() {
  return CAP_SOMPI;
}

export function faucetUrl() {
  return TN10_FAUCET;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function derivePinKey(pin, salt) {
  if (String(pin).length < 4) throw new Error("PIN must be at least 4 characters");
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importAes(raw) {
  return crypto.subtle.importKey("raw", raw.slice(0, 32), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptHex(privateKeyHex, aesKey, meta) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plain = new TextEncoder().encode(privateKeyHex.replace(/^0x/, "").toLowerCase());
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plain));
  return {
    v: 1,
    alg: "AES-GCM",
    kdf: meta.kdf,
    saltB64: b64(meta.salt),
    ivB64: b64(iv),
    ciphertextB64: b64(ct),
    credIdB64: meta.credIdB64,
  };
}

async function decryptHex(blob, aesKey) {
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(blob.ivB64) },
      aesKey,
      fromB64(blob.ciphertextB64),
    ),
  );
  const hex = new TextDecoder().decode(plain).trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Bad decrypted key");
  return hex;
}

function prfSupported() {
  try {
    return !!(window.PublicKeyCredential && navigator.credentials);
  } catch {
    return false;
  }
}

async function createPasskeyPrf(userIdBytes, salt) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: RP_NAME, id: location.hostname },
      user: {
        id: userIdBytes,
        name: "kaspa-quick-start",
        displayName: "Kaspa Quick-start wallet",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: "required",
      },
      timeout: 120000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!cred) throw new Error("Passkey creation cancelled");
  const ext = cred.getClientExtensionResults?.() || {};
  const results = ext.prf && ext.prf.results;
  const first = results && (results.first || results.First);
  if (!first) {
    throw new Error("PRF_UNSUPPORTED");
  }
  const raw = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first);
  return { credId: new Uint8Array(cred.rawId), prfRaw: raw };
}

async function getPasskeyPrf(credId, salt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      timeout: 120000,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credId }],
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!cred) throw new Error("Passkey cancelled");
  const ext = cred.getClientExtensionResults?.() || {};
  const results = ext.prf && ext.prf.results;
  const first = results && (results.first || results.First);
  if (!first) throw new Error("PRF_UNSUPPORTED");
  return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first);
}

async function generateKeypair(network) {
  await ensureKaspa();
  const mnemonic = Mnemonic.random(12);
  const phrase = mnemonic.phrase;
  const seed = mnemonic.toSeed("");
  const xprv = new XPrv(seed);
  // Kaspa standard receive path account 0 / receive 0
  const priv = xprv.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
  const xonly = priv.toPublicKey().toXOnlyPublicKey().toString();
  const address = priv.toPublicKey().toAddress(network).toString();
  const privateKeyHex = priv.toString();
  return { mnemonic: phrase, privateKeyHex, xonlyHex: xonly, address };
}

/**
 * Create & persist a quick-start wallet.
 * opts: { network, pin?, preferPasskey?=true, testPrivateKeyHex? }
 * Returns public info + mnemonic once (caller must show backup UI).
 */
export async function createWallet(opts) {
  const network = opts.network === "mainnet" ? "mainnet" : "testnet-10";
  await ensureKaspa();
  let generated;
  if (opts.testPrivateKeyHex) {
    const priv = new PrivateKey(String(opts.testPrivateKeyHex).replace(/^0x/, ""));
    generated = {
      mnemonic: null,
      privateKeyHex: priv.toString(),
      xonlyHex: priv.toPublicKey().toXOnlyPublicKey().toString(),
      address: priv.toPublicKey().toAddress(network).toString(),
    };
  } else {
    generated = await generateKeypair(network);
  }

  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  let enc;
  let unlock = "pin";

  const tryPasskey = opts.preferPasskey !== false && prfSupported() && !opts.forcePin;
  if (tryPasskey) {
    try {
      const { credId, prfRaw } = await createPasskeyPrf(
        new TextEncoder().encode("kaspa-qw-" + id),
        salt,
      );
      const aes = await importAes(prfRaw);
      enc = await encryptHex(generated.privateKeyHex, aes, {
        kdf: "WebAuthn-PRF",
        salt,
        credIdB64: b64url(credId),
      });
      unlock = "passkey-prf";
    } catch (e) {
      if (String(e && e.message) !== "PRF_UNSUPPORTED" && opts.requirePasskey) throw e;
      // fall through to PIN
    }
  }

  if (!enc) {
    const pin = opts.pin;
    if (!pin) throw new Error("PIN_REQUIRED");
    const aes = await derivePinKey(pin, salt);
    enc = await encryptHex(generated.privateKeyHex, aes, { kdf: "PBKDF2-SHA256", salt });
    unlock = "pin";
  }

  const record = {
    id,
    network,
    address: generated.address,
    xonlyHex: generated.xonlyHex,
    createdAt: Date.now(),
    backupAckAt: network === "mainnet" ? undefined : Date.now(),
    enc,
    unlock,
  };
  await idbPut(record);
  unlocked = {
    id,
    network,
    address: generated.address,
    xonlyHex: generated.xonlyHex,
    privateKeyHex: generated.privateKeyHex,
    mnemonic: generated.mnemonic,
  };
  return {
    id,
    network,
    address: generated.address,
    xonlyHex: generated.xonlyHex,
    unlock,
    mnemonic: generated.mnemonic,
    notice:
      "Clearing browser data deletes this wallet. Export your backup phrase before putting real money here.",
  };
}

export async function listWallets() {
  const all = await idbGetAll();
  return all.map((w) => ({
    id: w.id,
    network: w.network,
    address: w.address,
    unlock: w.unlock,
    backupAckAt: w.backupAckAt || null,
    createdAt: w.createdAt,
  }));
}

export async function unlockWallet(id, opts) {
  const rec = await idbGet(id);
  if (!rec) throw new Error("Wallet not found on this device");
  let aes;
  if (rec.unlock === "passkey-prf" || rec.enc.kdf === "WebAuthn-PRF") {
    const salt = fromB64(rec.enc.saltB64);
    const credId = fromB64url(rec.enc.credIdB64);
    const prfRaw = await getPasskeyPrf(credId, salt);
    aes = await importAes(prfRaw);
  } else {
    if (!opts || !opts.pin) throw new Error("PIN_REQUIRED");
    aes = await derivePinKey(opts.pin, fromB64(rec.enc.saltB64));
  }
  const privateKeyHex = await decryptHex(rec.enc, aes);
  unlocked = {
    id: rec.id,
    network: rec.network,
    address: rec.address,
    xonlyHex: rec.xonlyHex,
    privateKeyHex,
  };
  return publicSession();
}

export function lockWallet() {
  unlocked = null;
}

export function getUnlocked() {
  return unlocked ? publicSession() : null;
}

function publicSession() {
  if (!unlocked) return null;
  return {
    id: unlocked.id,
    network: unlocked.network,
    address: unlocked.address,
    xonlyHex: unlocked.xonlyHex,
    hasMnemonic: Boolean(unlocked.mnemonic),
  };
}

/** Test / e2e: inject an already-unlocked key without IndexedDB (never used in prod UI). */
export async function unlockForTest(opts) {
  await ensureKaspa();
  const network = opts.network === "mainnet" ? "mainnet" : "testnet-10";
  const priv = new PrivateKey(String(opts.privateKeyHex).replace(/^0x/, ""));
  unlocked = {
    id: "test",
    network,
    address: priv.toPublicKey().toAddress(network).toString(),
    xonlyHex: priv.toPublicKey().toXOnlyPublicKey().toString(),
    privateKeyHex: priv.toString(),
  };
  return publicSession();
}

export async function acknowledgeBackup(id) {
  const rec = await idbGet(id);
  if (!rec) throw new Error("Wallet not found");
  rec.backupAckAt = Date.now();
  await idbPut(rec);
  return { ok: true, backupAckAt: rec.backupAckAt };
}

export async function exportBackup() {
  if (!unlocked) throw new Error("Unlock first");
  // Prefer mnemonic if we still have it in-memory from create; else hex key.
  return {
    network: unlocked.network,
    address: unlocked.address,
    mnemonic: unlocked.mnemonic || null,
    privateKeyHex: unlocked.privateKeyHex,
    warning:
      "Anyone with this backup can spend your funds. Store offline. Never paste into chat.",
  };
}

export async function importWallet(opts) {
  const network = opts.network === "mainnet" ? "mainnet" : "testnet-10";
  await ensureKaspa();
  let privateKeyHex;
  let mnemonic = null;
  if (opts.mnemonic) {
    const m = new Mnemonic(String(opts.mnemonic).trim());
    mnemonic = m.phrase;
    const seed = m.toSeed("");
    const xprv = new XPrv(seed);
    privateKeyHex = xprv.derivePath("m/44'/111111'/0'/0/0").toPrivateKey().toString();
  } else if (opts.privateKeyHex) {
    privateKeyHex = String(opts.privateKeyHex).replace(/^0x/, "").toLowerCase();
  } else {
    throw new Error("Provide mnemonic or privateKeyHex");
  }
  return createWallet({
    network,
    pin: opts.pin,
    preferPasskey: opts.preferPasskey,
    forcePin: opts.forcePin,
    testPrivateKeyHex: privateKeyHex,
  });
}

export async function fetchBalanceSompi(address, utxoApiBase) {
  const url =
    String(utxoApiBase).replace(/\/$/, "") +
    "/addresses/" +
    encodeURIComponent(address) +
    "/utxos";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Balance fetch HTTP " + res.status);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.utxos || [];
  let sum = 0n;
  for (const u of list) {
    const entry = u.utxoEntry || u.entry || u;
    sum += BigInt(entry.amount ?? 0);
  }
  return sum;
}

export async function pollUntilFunded(opts) {
  const min = BigInt(opts.minSompi || 1);
  const deadline = Date.now() + (opts.timeoutMs || 180000);
  while (Date.now() < deadline) {
    const bal = await fetchBalanceSompi(opts.address, opts.utxoApiBase);
    if (bal >= min) return bal;
    await new Promise((r) => setTimeout(r, opts.intervalMs || 2500));
  }
  throw new Error("Timed out waiting for funds");
}

function requireUnlockedForNetwork(network) {
  if (!unlocked) throw new Error("Unlock your quick-start wallet first");
  if (unlocked.network !== network) {
    throw new Error(
      "Quick-start wallet is on " + unlocked.network + " but this tx is for " + network,
    );
  }
  return unlocked;
}

async function loadStored(id) {
  return idbGet(id);
}

/** Sign + broadcast a fund (P2PK → P2SH) or payment using unlocked key. */
export async function signAndPushSafeJson(safeJson, signInputs, kaspaNetwork) {
  await ensureKaspa();
  const session = requireUnlockedForNetwork(kaspaNetwork === "mainnet" ? "mainnet" : "testnet-10");
  const key = new PrivateKey(session.privateKeyHex.replace(/^0x/, ""));
  const tx = Transaction.deserializeFromSafeJSON(safeJson);
  const indices =
    (signInputs && signInputs.map((s) => s.index)) ||
    Array.from({ length: tx.inputs.length }, (_, i) => i);
  for (const i of indices) {
    const sig = createInputSignature(tx, i, key, SighashType.All);
    tx.inputs[i].signatureScript = sig;
  }
  const signed = tx.serializeToSafeJSON();
  return submitSigned(signed, kaspaNetwork);
}

function safeJsonToRestSubmit(safeJson) {
  const tx = JSON.parse(safeJson);
  return {
    version: tx.version ?? 0,
    inputs: (tx.inputs || []).map((inp) => ({
      previousOutpoint: {
        transactionId: inp.transactionId || inp.previousOutpoint?.transactionId,
        index: inp.index ?? inp.previousOutpoint?.index ?? 0,
      },
      signatureScript: String(inp.signatureScript || "").replace(/^0x/, ""),
      sequence: Number(inp.sequence || 0),
      sigOpCount: Number(inp.sigOpCount || 1),
    })),
    outputs: (tx.outputs || []).map((o) => {
      let script = String(o.scriptPublicKey || "");
      if (script.startsWith("0000") && script.length > 4) script = script.slice(4);
      return {
        amount: Number(o.value),
        scriptPublicKey: { version: 0, scriptPublicKey: script },
      };
    }),
    lockTime: Number(tx.lockTime || 0),
    subnetworkId: tx.subnetworkId || "0000000000000000000000000000000000000000",
  };
}

async function submitSignedRest(safeJson, net) {
  const api = net === "mainnet" ? "https://api.kaspa.org" : "https://api-tn10.kaspa.org";
  const res = await fetch(api + "/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transaction: safeJsonToRestSubmit(safeJson),
      allowOrphan: net !== "mainnet",
    }),
  });
  const json = await res.json().catch(() => ({}));
  const txid = json.transactionId || json.transaction_id;
  if (!res.ok || json.error) {
    const msg = json.error || json.detail || "submit HTTP " + res.status;
    const m = String(msg).match(/[a-f0-9]{64}/i);
    if (m) return m[0].toLowerCase();
    throw new Error(msg);
  }
  if (!txid) throw new Error("REST submit missing transactionId");
  return String(txid).toLowerCase();
}

export async function submitSigned(safeJson, kaspaNetwork) {
  await ensureKaspa();
  const net = kaspaNetwork || "testnet-10";
  const url =
    net === "mainnet"
      ? "wss://protonet.aspectron.org/kaspa/mainnet/wrpc/borsh"
      : "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh";
  try {
    const tx = Transaction.deserializeFromSafeJSON(safeJson);
    const rpc = new RpcClient({ url, encoding: Encoding.Borsh, networkId: net });
    const wrpc = (async () => {
      await rpc.connect();
      try {
        const res = await rpc.submitTransaction({ transaction: tx, allowOrphan: true });
        return res.transactionId || String(res);
      } finally {
        try {
          await rpc.disconnect();
        } catch (_) {}
      }
    })();
    const timed = new Promise((_, rej) => setTimeout(() => rej(new Error("wRPC timeout")), 8000));
    return await Promise.race([wrpc, timed]);
  } catch (e) {
    return submitSignedRest(safeJson, net);
  }
}

/**
 * Sign covenant spend: signPskt-equivalent → caller wraps unlock via l1-build.finalizeCovenantSpend.
 */
export async function signPsktLike(safeJson, signInputs) {
  await ensureKaspa();
  if (!unlocked) throw new Error("Unlock first");
  const key = new PrivateKey(unlocked.privateKeyHex.replace(/^0x/, ""));
  const tx = Transaction.deserializeFromSafeJSON(safeJson);
  const indices =
    (signInputs && signInputs.map((s) => s.index)) ||
    Array.from({ length: tx.inputs.length }, (_, i) => i);
  for (const i of indices) {
    const sig = createInputSignature(tx, i, key, SighashType.All);
    tx.inputs[i].signatureScript = sig;
  }
  return tx.serializeToSafeJSON();
}

export function xonlyHex() {
  if (!unlocked) throw new Error("Unlock first");
  return unlocked.xonlyHex;
}

export async function assertMainnetReady(id) {
  // E2E / unlockForTest sessions have no IndexedDB row
  if (unlocked && unlocked.id === "test") return true;
  const rec = await loadStored(id || (unlocked && unlocked.id));
  if (!rec) {
    if (unlocked && unlocked.network !== "mainnet") return true;
    throw new Error("Wallet not found");
  }
  if (rec.network === "mainnet" && !rec.backupAckAt) {
    throw new Error("BACKUP_REQUIRED");
  }
  return true;
}

export async function assertBalanceUnderCap(utxoApiBase) {
  if (!unlocked) throw new Error("Unlock first");
  const bal = await fetchBalanceSompi(unlocked.address, utxoApiBase);
  assertCap(bal);
  return bal;
}

/** Build + sign + broadcast a simple P2PK payment from the unlocked wallet. */
export async function sendPayment(opts) {
  await ensureKaspa();
  const network = opts.network === "mainnet" ? "mainnet" : "testnet-10";
  const session = requireUnlockedForNetwork(network);
  assertAddressNetwork(opts.toAddress, network);
  const amount = BigInt(opts.amountSompi);
  if (amount <= 0n) throw new Error("Amount must be > 0");
  if (network === "mainnet") {
    await assertMainnetReady(session.id);
  }
  const api =
    opts.utxoApiBase ||
    (network === "mainnet" ? "https://api.kaspa.org" : "https://api-tn10.kaspa.org");
  const bal = await fetchBalanceSompi(session.address, api);
  const priorityFee = BigInt(opts.priorityFeeSompi || 10000);
  if (opts.max) {
    // amount = balance - fee (createTransactions will compute exact fee; we estimate)
  } else {
    assertCap(bal);
    if (amount + priorityFee > bal) throw new Error("Insufficient balance");
    if (network === "mainnet") assertCap(amount);
  }

  const entriesUrl = api.replace(/\/$/, "") + "/addresses/" + encodeURIComponent(session.address) + "/utxos";
  const res = await fetch(entriesUrl);
  if (!res.ok) throw new Error("UTXO fetch HTTP " + res.status);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.utxos || [];
  const entries = list.map((u) => {
    const entry = u.utxoEntry || u.entry || u;
    const outpoint = u.outpoint || {
      transactionId: entry.transaction_id || entry.transactionId,
      index: entry.index,
    };
    let spkRaw = entry.scriptPublicKey ?? entry.script_public_key ?? "";
    let script = "";
    let version = 0;
    if (typeof spkRaw === "string") script = spkRaw;
    else if (spkRaw && typeof spkRaw === "object") {
      script = spkRaw.scriptPublicKey || spkRaw.script || "";
      version = spkRaw.version ?? 0;
    }
    script = String(script).replace(/^0x/, "");
    return {
      address: session.address,
      outpoint: {
        transactionId: String(outpoint.transactionId || outpoint.transaction_id),
        index: Number(outpoint.index),
      },
      amount: BigInt(entry.amount ?? 0),
      scriptPublicKey: { version, script },
      blockDaaScore: BigInt(entry.blockDaaScore ?? entry.block_daa_score ?? 0),
      isCoinbase: !!(entry.isCoinbase ?? entry.is_coinbase),
    };
  });
  if (!entries.length) throw new Error("No UTXOs");

  let sendAmount = amount;
  let feeForCreate = priorityFee;
  if (opts.max) {
    const total = entries.reduce((a, e) => a + e.amount, 0n);
    if (total <= priorityFee + 1000n) throw new Error("Insufficient funds for fee");
    sendAmount = total - priorityFee;
    feeForCreate = 0n; // fee already reserved in sendAmount
  }

  const { transactions, summary } = await createTransactions({
    entries,
    outputs: [{ address: opts.toAddress, amount: sendAmount }],
    changeAddress: session.address,
    priorityFee: feeForCreate,
    networkId: network,
  });
  const pending = transactions[0];
  if (!pending) throw new Error("createTransactions returned no tx");
  const tx = pending.transaction;
  const key = new PrivateKey(session.privateKeyHex.replace(/^0x/, ""));
  for (let i = 0; i < tx.inputs.length; i++) {
    tx.inputs[i].signatureScript = createInputSignature(tx, i, key, SighashType.All);
  }
  const txid = await submitSigned(tx.serializeToSafeJSON(), network);
  return {
    txid,
    feeSompi: String(summary?.fees ?? ""),
    amountSompi: String(sendAmount),
    toAddress: opts.toAddress,
    fromAddress: session.address,
  };
}

/** Minimal QR as SVG (byte-mode via table-free fallback: just show address if too long). */
export function qrSvgDataUrl(text, size) {
  // Lightweight: render as SVG text block if we lack a QR lib — UI also shows copyable address.
  // Prefer canvas-less placeholder pattern that agents can still screenshot.
  const esc = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
  const s = size || 180;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    s +
    '" height="' +
    s +
    '" viewBox="0 0 100 100">' +
    '<rect width="100" height="100" fill="#fff"/>' +
    '<text x="50" y="48" text-anchor="middle" font-size="4.2" font-family="monospace" fill="#000">Scan/copy address</text>' +
    '<foreignObject x="4" y="55" width="92" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="font:5px monospace;word-break:break-all;color:#000">' +
    esc +
    "</div></foreignObject></svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

export const DATA_LOSS_NOTICE =
  "This wallet lives only on this device/browser. Clearing site data, switching browsers, or losing the phone deletes it unless you saved a backup.";
