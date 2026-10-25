import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { utils } from "@coral-xyz/anchor";
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { check, CLMM, RPC, WALLET } from "./config";

export const STATE_DIR = path.join(os.homedir(), ".config/solana/liquidity_vault/week11-raydium");
export const STATE_PATH = path.join(STATE_DIR, "state.json");
const repository = fs.realpathSync(path.resolve(__dirname, "../../.."));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Receipt {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  status: "pending" | "finalized" | "failed";
  slot?: number;
  broadcastError?: string;
}
export interface State {
  version: 1;
  cluster: "devnet";
  program: string;
  wallet: string;
  mintA: string;
  mintB: string;
  nftMint: string;
  receipts: Record<string, Receipt>;
  positionBefore?: { wallet0: string; wallet1: string; vault0: string; vault1: string };
  proof?: Record<string, unknown>;
}
export function outsideRepository(location: string) {
  const relative = path.relative(repository, fs.realpathSync(location));
  check(relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    "Keys and state must be outside the repository");
}
export async function readRpc<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (attempt === 3 || !/429|Too Many Requests|fetch failed|timed? ?out|ECONNRESET/i.test(String(error))) throw error;
      await delay(2_000 * 2 ** attempt);
    }
  }
}
export function validateState(state: State): State {
  check(state.version === 1 && state.cluster === "devnet" && state.program === CLMM.toBase58()
    && state.wallet === WALLET.toBase58(), "Unexpected saved Week 11 state");
  return state;
}
export function readState(): State {
  outsideRepository(STATE_DIR);
  return validateState(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")));
}
export function saveState(state: State) {
  fs.writeFileSync(`${STATE_PATH}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
}
export function externalKey(name: "mint-a" | "mint-b" | "position-nft", create = false): Keypair {
  const location = path.join(STATE_DIR, `${name}-keypair.json`);
  if (!fs.existsSync(location)) {
    check(create, `Missing external ${name} key; do not replace an existing mint`);
    const key = Keypair.generate();
    fs.writeFileSync(location, JSON.stringify(Array.from(key.secretKey)), { flag: "wx", mode: 0o600 });
  }
  outsideRepository(location);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(location, "utf8"))));
}
export function loadWallet(): Keypair {
  const location = process.env.ANCHOR_WALLET;
  check(location, "Set ANCHOR_WALLET to the existing external Devnet wallet");
  outsideRepository(location);
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(location, "utf8"))));
  check(wallet.publicKey.equals(WALLET), "Wrong wallet for this Week 11 project");
  return wallet;
}
export function createState(): State {
  check(!fs.existsSync(STATE_PATH), "State already exists");
  const state: State = { version: 1, cluster: "devnet", program: CLMM.toBase58(), wallet: WALLET.toBase58(),
    mintA: externalKey("mint-a", true).publicKey.toBase58(), mintB: externalKey("mint-b", true).publicKey.toBase58(),
    nftMint: externalKey("position-nft", true).publicKey.toBase58(), receipts: {} };
  saveState(state);
  return state;
}
export function acquireLock(): () => void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  outsideRepository(STATE_DIR);
  const lockPath = path.join(STATE_DIR, "run.lock");
  const fd = fs.openSync(lockPath, "wx", 0o600);
  let released = false;
  const release = () => {
    if (!released) { released = true; fs.closeSync(fd); fs.unlinkSync(lockPath); }
  };
  process.once("exit", release);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  return release;
}
export function connection() {
  return new Connection(RPC, { commitment: "finalized", disableRetryOnRateLimit: true });
}
export async function confirmReceipt(rpc: Connection, receipt: Receipt): Promise<void> {
  for (let poll = 0; poll < 30; poll++) {
    const status = (await readRpc(() => rpc.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true }))).value[0];
    if (status?.err) { receipt.status = "failed"; throw new Error(`Transaction failed: ${receipt.signature} ${JSON.stringify(status.err)}`); }
    if (status?.confirmationStatus === "finalized") { receipt.status = "finalized"; receipt.slot = status.slot; return; }
    if (poll < 29) await delay(2_000);
  }
  throw new Error(`Unresolved signature ${receipt.signature}. Re-run checks only; never delete state or blindly resend.`);
}
export async function sendOnce(rpc: Connection, wallet: Keypair, state: State, name: string,
  build: () => Promise<{ instructions: TransactionInstruction[]; signers?: Keypair[] }>,
  persist: (state: State) => void = saveState) {
  if (!state.receipts[name]) {
    check(await readRpc(() => rpc.getBalance(wallet.publicKey)) >= 300_000_000, "Need at least 0.3 test SOL before creating accounts");
    const { instructions, signers = [] } = await build();
    const latest = await readRpc(() => rpc.getLatestBlockhash("confirmed"));
    const tx = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(...instructions);
    tx.sign(wallet, ...signers);
    const signature = utils.bytes.bs58.encode(tx.signature!);
    state.receipts[name] = { signature, ...latest, status: "pending" };
    persist(state); // Durable signature before the only broadcast.
    console.log(`${name}: ${signature}`);
    try {
      const returned = await rpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0,
      });
      check(returned === signature, "RPC returned a different signature");
    } catch (error) {
      state.receipts[name].broadcastError = String(error);
      persist(state);
      console.warn(`${name}: checking recorded signature after broadcast error; no resend`);
    }
  }
  try { await confirmReceipt(rpc, state.receipts[name]); } finally { persist(state); }
}
