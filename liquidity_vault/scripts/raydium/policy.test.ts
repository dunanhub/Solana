import { expect } from "chai";
import { createHash } from "crypto";
import { AccountInfo, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ClmmConfigLayout, MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64 } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { accountData, checkConfig, checkNetwork, checkRange, CLMM, CONFIG, GENESIS, INITIAL_SQRT,
  orderedMints, quotePosition, RPC, WALLET } from "./config";
import { sendOnce, State, validateState } from "./runtime";

describe("Week 11 Raydium safeguards (offline)", () => {
  function configInfo(): AccountInfo<Buffer> {
    const data = Buffer.alloc(ClmmConfigLayout.span);
    createHash("sha256").update("account:AmmConfig").digest().copy(data, 0, 0, 8);
    data.writeUInt16LE(0, 9); data.writeUInt32LE(2500, 47); data.writeUInt16LE(60, 51);
    return { data, owner: CLMM, lamports: 1, executable: false, rentEpoch: 0 };
  }
  it("accepts the verified Devnet endpoint, genesis and program", () => checkNetwork(RPC, GENESIS, CLMM));
  it("rejects Mainnet RPC even if another value claims Devnet", () => {
    expect(() => checkNetwork("https://api.mainnet-beta.solana.com", GENESIS, CLMM)).to.throw("Devnet");
  });
  it("rejects a wrong genesis", () => expect(() => checkNetwork(RPC, "wrong", CLMM)).to.throw("Devnet"));
  it("rejects the Mainnet CLMM address", () => {
    expect(() => checkNetwork(RPC, GENESIS, new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"))).to.throw("program");
  });
  it("orders by public key bytes independently of input order", () => {
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    expect(orderedMints(a, b).map(String)).to.deep.equal(orderedMints(b, a).map(String));
    expect(Buffer.compare(...orderedMints(a, b).map((key) => key.toBuffer()) as [Buffer, Buffer])).to.equal(-1);
  });
  it("rejects identical token mints", () => expect(() => orderedMints(WALLET, WALLET)).to.throw("must differ"));
  it("accepts the configured fee and spacing", () => expect(checkConfig(CONFIG, configInfo()).tradeFeeRate).to.equal(2500));
  it("rejects another config address", () => expect(() => checkConfig(WALLET, configInfo())).to.throw("address"));
  it("rejects a config owned by another program", () => {
    expect(() => checkConfig(CONFIG, { ...configInfo(), owner: SystemProgram.programId })).to.throw("owner");
  });
  it("rejects missing, truncated and wrong-discriminator CLMM accounts", () => {
    expect(() => accountData(null, "AmmConfig", ClmmConfigLayout.span)).to.throw("missing");
    const info = configInfo();
    expect(() => checkConfig(CONFIG, { ...info, data: info.data.subarray(1) })).to.throw("size");
    info.data[0] ^= 255;
    expect(() => checkConfig(CONFIG, info)).to.throw("discriminator");
  });
  for (const [offset, value, label] of [[47, 10000, "fee"], [51, 120, "spacing"]] as const) {
    it(`rejects unexpected config ${label}`, () => {
      const info = configInfo();
      if (offset === 47) info.data.writeUInt32LE(value, offset); else info.data.writeUInt16LE(value, offset);
      expect(() => checkConfig(CONFIG, info)).to.throw("fee tier or tick spacing");
    });
  }
  it("rejects unaligned, reversed, equal, fractional and out-of-bounds ticks", () => {
    for (const [lower, upper] of [[-601, 600], [600, -600], [0, 0], [-600.5, 600], [-443700, 600]]) {
      expect(() => checkRange(lower, upper, 60, INITIAL_SQRT)).to.throw("tick range");
    }
  });
  it("rejects invalid spacing, sqrt bounds and an out-of-range initial price", () => {
    expect(() => checkRange(-600, 600, 0, INITIAL_SQRT)).to.throw("spacing");
    for (const sqrt of [new BN(0), MIN_SQRT_PRICE_X64.subn(1), MAX_SQRT_PRICE_X64]) {
      expect(() => checkRange(-600, 600, 60, sqrt)).to.throw("sqrtPrice");
    }
    expect(() => checkRange(60, 600, 60, INITIAL_SQRT)).to.throw("inside");
  });
  it("quotes nonzero liquidity, bounded token amounts and rounded-up 1% limits", () => {
    const q = quotePosition();
    expect(INITIAL_SQRT.toString()).to.equal("18446744073709551616");
    expect(q.liquidity.gtn(10_000_000)).to.equal(true);
    for (const [amount, max] of [[q.amountA, q.maxA], [q.amountB, q.maxB]]) {
      expect(amount.gtn(0) && amount.lten(10_000_001)).to.equal(true);
      expect(max.muln(10000).gte(amount.muln(10100))).to.equal(true);
      expect(max.subn(1).muln(10000).lt(amount.muln(10100))).to.equal(true);
    }
  });
  function state(): State {
    return { version: 1, cluster: "devnet", program: CLMM.toBase58(), wallet: WALLET.toBase58(),
      mintA: Keypair.generate().publicKey.toBase58(), mintB: Keypair.generate().publicKey.toBase58(),
      nftMint: Keypair.generate().publicKey.toBase58(), receipts: {} };
  }
  it("rejects a saved manifest for another cluster, program or wallet", () => {
    const saved = state();
    expect(validateState(saved)).to.equal(saved);
    for (const overrides of [{ cluster: "mainnet" }, { program: WALLET.toBase58() }, { wallet: CLMM.toBase58() }]) {
      expect(() => validateState({ ...saved, ...overrides } as State)).to.throw("saved Week 11 state");
    }
  });
  it("a recorded signature is checked without rebuilding or broadcasting", async () => {
    const saved = state();
    saved.receipts.pool = { signature: "recorded", blockhash: "old", lastValidBlockHeight: 1, status: "pending" };
    const rpc = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", slot: 7, err: null }] }) } as unknown as Connection;
    await sendOnce(rpc, Keypair.generate(), saved, "pool", async () => { throw new Error("must not build"); }, () => {});
    expect(saved.receipts.pool.status).to.equal("finalized");
  });
  it("persists before broadcast and resolves a lost response without sending twice", async () => {
    const saved = state(), wallet = Keypair.generate();
    let persisted = false, sends = 0;
    const rpc = { getBalance: async () => 1_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      sendRawTransaction: async (_raw: Buffer, options: { skipPreflight: boolean; maxRetries: number }) => {
        expect(persisted && !!saved.receipts.pool.signature).to.equal(true);
        expect(options).to.include({ skipPreflight: false, maxRetries: 0 });
        sends++; throw new Error("lost response");
      },
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", slot: 8, err: null }] }),
    } as unknown as Connection;
    await sendOnce(rpc, wallet, saved, "pool", async () => ({ instructions: [SystemProgram.transfer({
      fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 0,
    })] }), () => { persisted = true; });
    expect(sends).to.equal(1);
    expect(saved.receipts.pool.status).to.equal("finalized");
  });
  it("a recorded on-chain failure stops the workflow without creating another transaction", async () => {
    const saved = state();
    saved.receipts.pool = { signature: "failed", blockhash: "old", lastValidBlockHeight: 1, status: "pending" };
    const rpc = { getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, "InvalidArgument"] } }] }) } as unknown as Connection;
    let message = "";
    try {
      await sendOnce(rpc, Keypair.generate(), saved, "pool", async () => { throw new Error("must not build"); }, () => {});
    } catch (error) { message = String(error); }
    expect(message).to.include("Transaction failed");
    expect(saved.receipts.pool.status).to.equal("failed");
  });
});
