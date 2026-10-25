import { utils } from "@coral-xyz/anchor";
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { check } from "../raydium/config";
import { confirmReceipt, readRpc, Receipt } from "../raydium/runtime";

export interface Journal {
  receipts: Record<string, Receipt>;
  retired?: Record<string, Array<Receipt & { reason: "expired-unseen"; finalizedHeight: number }>>;
}
/** Explicit recovery only: prove expiry AND absence, preserving the original receipt. */
export async function retireExpiredStep(rpc: Connection, state: Journal, name: string, persist: () => void) {
  const receipt = state.receipts[name];
  check(receipt?.status === "pending", "Only a pending receipt can be reconciled");
  const height = await readRpc(() => rpc.getBlockHeight("finalized"));
  check(height > receipt.lastValidBlockHeight, "Blockhash has not expired at finalized commitment");
  const status = (await readRpc(() => rpc.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true }))).value[0];
  check(status === null, "Signature was observed; resolve its actual status instead");
  const tx = await readRpc(() => rpc.getTransaction(receipt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
  check(tx === null, "Transaction exists; do not replace it");
  check(!(await readRpc(() => rpc.isBlockhashValid(receipt.blockhash, { commitment: "finalized" }))).value, "Blockhash is still valid");
  state.retired ??= {};
  state.retired[name] ??= [];
  state.retired[name].push({ ...receipt, reason: "expired-unseen", finalizedHeight: height });
  delete state.receipts[name];
  persist();
}
/** Persist the signed transaction's identity before its only broadcast. Never retry writes. */
export async function sendStep(rpc: Connection, wallet: Keypair, state: Journal, name: string,
  build: () => Promise<TransactionInstruction[]>, persist: () => void) {
  if (!state.receipts[name]) {
    const instructions = await build();
    const latest = await readRpc(() => rpc.getLatestBlockhash("confirmed"));
    const tx = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(...instructions);
    tx.sign(wallet);
    const signature = utils.bytes.bs58.encode(tx.signature!);
    state.receipts[name] = { signature, ...latest, status: "pending" };
    persist();
    console.log(`${name}: ${signature}`);
    try {
      check(await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false,
        preflightCommitment: "confirmed", maxRetries: 0 }) === signature, "Unexpected RPC signature");
    } catch (error) {
      state.receipts[name].broadcastError = String(error);
      persist();
      console.warn(`${name}: checking saved signature; no automatic rebroadcast`);
    }
  }
  check(state.receipts[name].status !== "failed", `Recorded failed step: ${name}; inspect before any recovery`);
  try { await confirmReceipt(rpc, state.receipts[name]); } finally { persist(); }
}
