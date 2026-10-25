import { expect } from "chai";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { sendStep, retireExpiredStep, Journal } from "./journal";

describe("Week 12 transaction journal safeguards", () => {
  const wallet = Keypair.generate();
  const build = async () => [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 0 })];
  const neverBuild = async (): Promise<never> => { throw new Error("must not build a second transaction"); };
  function pending(): Journal {
    return { receipts: { swap: { signature: "saved", blockhash: "old", lastValidBlockHeight: 1, status: "pending" } } };
  }
  async function fails(action: () => Promise<unknown>, message: string) {
    let error: unknown; try { await action(); } catch (e) { error = e; }
    expect(String(error)).to.include(message);
  }
  it("resolves a pending signature without rebuilding or sending", async () => {
    const state = pending();
    const rpc = { getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "finalized", slot: 10 }] }) } as unknown as Connection;
    await sendStep(rpc, wallet, state, "swap", neverBuild, () => {});
    expect(state.receipts.swap.status).to.equal("finalized");
  });
  it("persists before broadcast, keeps preflight, and resolves a lost response", async () => {
    const state: Journal = { receipts: {} }; let saved = false, broadcasts = 0;
    const rpc = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      sendRawTransaction: async (_raw: Buffer, options: unknown) => {
        expect(saved && !!state.receipts.swap.signature).to.equal(true);
        expect(options).to.deep.equal({ skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
        broadcasts++; throw new Error("response lost after acceptance");
      },
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "finalized", slot: 11 }] }),
    } as unknown as Connection;
    await sendStep(rpc, wallet, state, "swap", build, () => { saved = true; });
    await sendStep(rpc, wallet, state, "swap", neverBuild, () => {});
    expect(broadcasts).to.equal(1);
    expect(state.receipts.swap.broadcastError).to.include("response lost");
  });
  it("does not broadcast if durable storage fails", async () => {
    let broadcasts = 0;
    const rpc = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      sendRawTransaction: async () => { broadcasts++; },
    } as unknown as Connection;
    await fails(() => sendStep(rpc, wallet, { receipts: {} }, "swap", build, () => { throw new Error("disk full"); }), "disk full");
    expect(broadcasts).to.equal(0);
  });
  it("records an on-chain failure and refuses another transaction on the next run", async () => {
    const state = pending(); let writes = 0;
    const rpc = { getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [1, { Custom: 6020 }] } }] }) } as unknown as Connection;
    await fails(() => sendStep(rpc, wallet, state, "swap", neverBuild, () => { writes++; }), "Transaction failed");
    expect(state.receipts.swap.status).to.equal("failed"); expect(writes).to.equal(1);
    await fails(() => sendStep({} as Connection, wallet, state, "swap", neverBuild, () => {}), "Recorded failed step");
  });
  it("keeps an unresolved signature on a non-retryable RPC failure", async () => {
    const state = pending(); let persisted = false;
    const rpc = { getSignatureStatuses: async () => { throw new Error("RPC unavailable"); } } as unknown as Connection;
    await fails(() => sendStep(rpc, wallet, state, "swap", neverBuild, () => { persisted = true; }), "RPC unavailable");
    expect(persisted).to.equal(true); expect(state.receipts.swap.status).to.equal("pending");
    expect(state.receipts.swap.signature).to.equal("saved");
  });
  function expiredRpc(overrides = {}) {
    return { getBlockHeight: async () => 10, getSignatureStatuses: async () => ({ value: [null] }),
      getTransaction: async () => null, isBlockhashValid: async () => ({ value: false }), ...overrides } as unknown as Connection;
  }
  it("archives an expired unseen signature before allowing an explicit replacement", async () => {
    const state = pending(); let persisted = false;
    await retireExpiredStep(expiredRpc(), state, "swap", () => { persisted = true; });
    expect(persisted).to.equal(true); expect(state.receipts.swap).to.equal(undefined);
    expect(state.retired!.swap[0]).to.include({ signature: "saved", reason: "expired-unseen", finalizedHeight: 10 });
  });
  for (const [name, overrides, message] of [
    ["unexpired height", { getBlockHeight: async () => 1 }, "has not expired"],
    ["observed signature", { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "processed" }] }) }, "Signature was observed"],
    ["existing transaction", { getTransaction: async () => ({ slot: 7 }) }, "Transaction exists"],
    ["valid blockhash", { isBlockhashValid: async () => ({ value: true }) }, "still valid"],
  ] as const) {
    it(`refuses recovery for ${name} and preserves the journal`, async () => {
      const state = pending(), before = JSON.stringify(state);
      await fails(() => retireExpiredStep(expiredRpc(overrides), state, "swap", () => { throw new Error("must not persist"); }), message);
      expect(JSON.stringify(state)).to.equal(before);
    });
  }
});
