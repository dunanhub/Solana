import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createMint, mintTo, getAccount, getMint, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync, transferChecked, freezeAccount, thawAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ApiV3Token, ClmmInstrument, getPdaPersonalPositionAddress, getPdaProtocolPositionAddress,
  getPdaTickArrayAddress, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { CLMM, CONFIG, INITIAL_SQRT, orderedMints, quotePosition, TICK_LOWER, TICK_UPPER, TICK_SPACING } from "../scripts/raydium/config";
import { vaultKeys, userKeys, strategyKeys, manageKeys, swapKeys, ASSOCIATED_TOKEN_PROGRAM_ID } from "../scripts/strategy/client";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("liquidity_vault — Week 12 real Raydium CPI strategy", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(env.connection.rpcEndpoint, "confirmed"), env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" });
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider.connection.rpcEndpoint).hostname)) throw new Error("Local validator required");
  const idl: LiquidityVault = JSON.parse(readFileSync(join(__dirname, "../target/idl/liquidity_vault.json"), "utf8"));
  const program = new anchor.Program<LiquidityVault>(idl, provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const alice = Keypair.generate(), outsider = Keypair.generate();
  const bn = (n: bigint | number) => new anchor.BN(n.toString());
  const token = (mint: PublicKey): ApiV3Token => ({ address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6, chainId: 101, name: "Local fixture", symbol: "TEST", logoURI: "", tags: [], extensions: {} });
  type Fixture = { asset: PublicKey; quote: PublicKey; pool: PublicKey };
  let main: Fixture, other: Fixture;
  let forwardSignature: string;
  let roundTripAssets: bigint;
  async function fixture(assetIs0: boolean): Promise<Fixture> {
    const first = await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, 6);
    const second = await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, 6);
    const [token0, token1] = orderedMints(first, second);
    const [asset, quote] = assetIs0 ? [token0, token1] : [token1, token0];
    for (const mint of [asset, quote]) {
      for (const owner of [payer.publicKey, alice.publicKey]) {
        const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner);
        await mintTo(provider.connection, payer, mint, ata.address, payer, 100_000_000n);
      }
    }
    const poolBuild = ClmmInstrument.createPoolInstructions({ connection: provider.connection, programId: CLMM,
      owner: payer.publicKey, mintA: token(token0), mintB: token(token1), ammConfigId: CONFIG, initialPriceX64: INITIAL_SQRT });
    await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...poolBuild.instructions));
    const pool = poolBuild.address.poolId, nft = Keypair.generate(), q = quotePosition();
    const lowerStart = TickArrayUtil.getTickArrayStartIndex(TICK_LOWER, TICK_SPACING);
    const upperStart = TickArrayUtil.getTickArrayStartIndex(TICK_UPPER, TICK_SPACING);
    const ix = ClmmInstrument.openPositionWithToken22NftInstruction(CLMM, payer.publicKey, pool, payer.publicKey,
      nft.publicKey, getAssociatedTokenAddressSync(nft.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID),
      getPdaProtocolPositionAddress(CLMM, pool, TICK_LOWER, TICK_UPPER).publicKey,
      getPdaTickArrayAddress(CLMM, pool, lowerStart).publicKey, getPdaTickArrayAddress(CLMM, pool, upperStart).publicKey,
      getPdaPersonalPositionAddress(CLMM, nft.publicKey).publicKey,
      getAssociatedTokenAddressSync(token0, payer.publicKey), getAssociatedTokenAddressSync(token1, payer.publicKey),
      poolBuild.address.mintAVault, poolBuild.address.mintBVault, token0, token1, TICK_LOWER, TICK_UPPER,
      lowerStart, upperStart, q.liquidity, q.maxA, q.maxB, true, null);
    await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix), [nft]);
    const { strategy: _strategy, ...v } = vaultKeys(asset);
    await program.methods.initializeVault().accountsStrict({ ...v, administrator: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
    const user = userKeys(asset, alice.publicKey);
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, v.shareMint, alice.publicKey);
    await program.methods.openPosition().accountsStrict({ ...v, user: alice.publicKey, position: user.position,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    await program.methods.deposit(bn(1_000_000), bn(1_000_000)).accountsStrict(user).signers([alice]).rpc();
    return { asset, quote, pool };
  }
  function init(f: Fixture, overrides = {}) {
    return program.methods.initializeStrategy().accountsStrict({ ...strategyKeys(f.asset, f.quote, payer.publicKey),
      pool: f.pool, raydiumProgram: CLMM, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, ...overrides });
  }
  function end(f: Fixture, overrides = {}) {
    return program.methods.endStrategy().accountsStrict({ ...manageKeys(f.asset, f.quote, payer.publicKey), ...overrides });
  }
  function start(f: Fixture, overrides = {}) {
    return program.methods.startStrategy().accountsStrict({ ...manageKeys(f.asset, f.quote, payer.publicKey), ...overrides });
  }
  async function swap(f: Fixture, aToB: boolean, amount: bigint, min: bigint, overrides = {},
    tickOverride?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], limitOverride?: anchor.BN) {
    const s = await swapKeys(provider.connection, f.asset, f.quote, f.pool, payer.publicKey, aToB);
    return program.methods.swap(aToB, bn(amount), bn(min), limitOverride ?? s.limit)
      .accountsStrict({ ...s.accounts, ...overrides }).remainingAccounts(tickOverride ?? s.ticks)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })]).rpc();
  }
  async function snapshot(f: Fixture) {
    const s = await swapKeys(provider.connection, f.asset, f.quote, f.pool, payer.publicKey, true);
    const keys = [...Object.values(vaultKeys(f.asset)), strategyKeys(f.asset, f.quote, payer.publicKey).quoteVault,
      ...Object.values(userKeys(f.asset, alice.publicKey)), s.accounts.pool, s.accounts.poolAssetVault,
      s.accounts.poolQuoteVault, s.accounts.observation, s.accounts.bitmap,
      ...[TICK_LOWER, TICK_UPPER].map((t) => getPdaTickArrayAddress(CLMM, f.pool, TickArrayUtil.getTickArrayStartIndex(t, 60)).publicKey)];
    const unique = [...new Map(keys.filter((key) => !key.equals(alice.publicKey)).map((key) => [key.toBase58(), key])).values()];
    const infos = await provider.connection.getMultipleAccountsInfo(unique);
    return infos.map((info) => info && ({ data: info.data.toString("base64"), owner: info.owner.toBase58(), lamports: info.lamports }));
  }
  async function rejects(f: Fixture, action: () => Promise<unknown>, pattern: RegExp) {
    const before = await snapshot(f);
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, "operation unexpectedly succeeded").not.to.equal(undefined);
    const e = caught as { logs?: string[]; message?: string };
    const logs = [String(caught), e.message, ...(e.logs ?? [])].join("\n");
    expect(logs).to.match(pattern);
    expect(await snapshot(f), "failed transaction changed Vault or Raydium state").to.deep.equal(before);
    return logs;
  }
  async function balances(f: Fixture) {
    const v = vaultKeys(f.asset), a = strategyKeys(f.asset, f.quote, payer.publicKey);
    return { a: (await getAccount(provider.connection, v.tokenVault)).amount,
      b: (await getAccount(provider.connection, a.quoteVault)).amount,
      supply: (await getMint(provider.connection, v.shareMint)).supply,
      shares: (await getAccount(provider.connection, userKeys(f.asset, alice.publicKey).userShareAccount)).amount };
  }
  before(async () => {
    await provider.sendAndConfirm(new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: alice.publicKey, lamports: 100_000_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: outsider.publicKey, lamports: 100_000_000 }),
    ));
    main = await fixture(true); other = await fixture(false);
  });
  it("requires the real Vault administrator to initialize", async () => {
    await rejects(main, () => init(main, { administrator: outsider.publicKey }).signers([outsider]).rpc(), /ConstraintHasOne/);
  });
  it("rejects a wrong quote mint before activating", async () => {
    const quoteVault = getAssociatedTokenAddressSync(other.quote, vaultKeys(main.asset).vault, true);
    await rejects(main, () => init(main, { quoteMint: other.quote, quoteVault }).rpc(), /InvalidRaydiumAccount/);
  });
  it("rejects a pool for another mint pair", async () => {
    await rejects(main, () => init(main, { pool: other.pool }).rpc(), /InvalidRaydiumAccount/);
  });
  it("rejects a substitute CPI program at initialization", async () => {
    await rejects(main, () => init(main, { raydiumProgram: SystemProgram.programId }).rpc(), /ConstraintAddress/);
  });
  it("initializes Strategy PDA and creates a canonical quote ATA owned by Vault", async () => {
    await init(main).rpc();
    const v = vaultKeys(main.asset), s = await program.account.strategy.fetch(v.strategy);
    expect(s.active).to.equal(true); expect(s.pool.equals(main.pool)).to.equal(true);
    expect(s.vault.equals(v.vault)).to.equal(true); expect(s.administrator.equals(payer.publicKey)).to.equal(true);
    expect(s.recordedQuoteBalance.toString()).to.equal("0");
    expect((await getAccount(provider.connection, s.quoteVault)).owner.equals(v.vault)).to.equal(true);
    expect((await program.account.vaultConfig.fetch(v.vault)).version).to.equal(0x81);
    expect((await provider.connection.getAccountInfo(v.vault))!.data.length).to.equal(140);
    expect((await provider.connection.getAccountInfo(v.strategy))!.data.length).to.equal(314);
  });
  it("rejects repeated initialization instead of resetting the strategy", async () => {
    await rejects(main, () => init(main).rpc(), /already in use|already been processed/);
  });
  it("blocks the original deposit API without requiring a caller-supplied guard account", async () => {
    const method = program.methods.deposit(bn(1000), bn(1)).accountsStrict(userKeys(main.asset, alice.publicKey)).signers([alice]);
    expect((await method.instruction()).keys.length).to.equal(9);
    await rejects(main, () => method.rpc(), /StrategyActive/);
  });
  it("blocks the original withdraw API and leaves shares/history unchanged", async () => {
    await rejects(main, () => program.methods.withdraw(bn(1000), bn(1)).accountsStrict(userKeys(main.asset, alice.publicKey)).signers([alice]).rpc(), /StrategyActive/);
  });
  it("keeps another Vault without a strategy usable", async () => {
    await program.methods.deposit(bn(1000), bn(1000)).accountsStrict(userKeys(other.asset, alice.publicKey)).signers([alice]).rpc();
  });
  it("rejects an unauthorized swap administrator", async () => {
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, outsider.publicKey, true);
    await rejects(main, () => program.methods.swap(true, bn(10000), bn(1), s.limit).accountsStrict(s.accounts)
      .remainingAccounts(s.ticks).signers([outsider]).rpc(), /ConstraintHasOne/);
  });
  it("requires an administrator signature", async () => {
    await rejects(main, () => end(main, { administrator: outsider.publicKey }).rpc(), /Signature verification failed|Missing signature/);
  });
  for (const [field, replacement] of [
    ["vault", () => vaultKeys(other.asset).vault], ["strategy", () => vaultKeys(other.asset).strategy],
    ["pool", () => other.pool], ["quoteMint", () => other.quote],
    ["quoteVault", () => getAssociatedTokenAddressSync(main.quote, alice.publicKey)],
    ["tokenVault", () => userKeys(main.asset, alice.publicKey).userAssetAccount],
    ["raydiumProgram", () => SystemProgram.programId], ["config", () => SystemProgram.programId],
    ["observation", () => other.pool], ["bitmap", () => other.pool],
    ["tokenProgram", () => SystemProgram.programId], ["tokenProgram2022", () => TOKEN_PROGRAM_ID],
    ["memoProgram", () => SystemProgram.programId],
  ] as const) {
    it(`rejects substituted ${field}`, async () => {
      await rejects(main, () => swap(main, true, 10000n, 1n, { [field]: replacement() }),
        /ConstraintSeeds|ConstraintHasOne|ConstraintAddress|InvalidProgramId|AccountNotInitialized|ConstraintOwner/);
    });
  }
  for (const field of ["poolAssetVault", "poolQuoteVault"] as const) {
    it(`rejects substituted ${field}`, async () => {
      const s = await swapKeys(provider.connection, other.asset, other.quote, other.pool, payer.publicKey, true);
      await rejects(main, () => swap(main, true, 10000n, 1n, { [field]: s.accounts[field] }), /ConstraintHasOne/);
    });
  }
  it("rejects empty tick arrays", async () => {
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, []), /InvalidTickArray/);
  });
  it("rejects tick arrays belonging to another pool", async () => {
    const s = await swapKeys(provider.connection, other.asset, other.quote, other.pool, payer.publicKey, true);
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, s.ticks), /InvalidRaydiumAccount/);
  });
  it("rejects duplicated tick arrays", async () => {
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, payer.publicKey, true);
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, [s.ticks[0], s.ticks[0]]), /InvalidTickArray/);
  });
  it("rejects a read-only tick array", async () => {
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, payer.publicKey, true);
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, [{ ...s.ticks[0], isWritable: false }]), /InvalidTickArray/);
  });
  it("rejects zero amount and zero minimum", async () => {
    await rejects(main, () => swap(main, true, 0n, 1n), /InvalidSwapAmount/);
    await rejects(main, () => swap(main, true, 1n, 0n), /InvalidSwapAmount/);
  });
  it("rejects insufficient input balance", async () => {
    await rejects(main, () => swap(main, true, 1n << 63n, 1n), /InsufficientFunds/);
  });
  it("rejects an unbounded or wrong-direction price limit", async () => {
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, undefined, bn(0)), /InvalidPriceLimit/);
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, payer.publicKey, true);
    await rejects(main, () => swap(main, true, 10000n, 1n, {}, undefined, s.data.sqrtPriceX64), /InvalidPriceLimit/);
  });
  it("rolls back Raydium state and token transfers when min output cannot be met", async () => {
    const logs = await rejects(main, () => swap(main, true, 10000n, 1_000_000_000n), /TooLittleOutputReceived/);
    expect(logs).to.include(`Program ${CLMM.toBase58()} invoke [2]`);
  });
  it("rolls back a successful CPI if the price bound causes a partial fill", async () => {
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, payer.publicKey, true);
    const limit = s.data.sqrtPriceX64.muln(s.zeroForOne ? 99999 : 100001).divn(100000);
    const logs = await rejects(main, () => swap(main, true, 10000n, 1n, {}, undefined, limit), /PartialSwap/);
    expect(logs).to.include(`Program ${CLMM.toBase58()} success`);
  });
  it("preserves all accounts when a quote token transfer fails inside Raydium", async () => {
    const quoteAta = strategyKeys(main.asset, main.quote, payer.publicKey).quoteVault;
    await freezeAccount(provider.connection, payer, quoteAta, main.quote, payer);
    await rejects(main, () => swap(main, true, 10000n, 1n), /frozen|0x11/i);
    await thawAccount(provider.connection, payer, quoteAta, main.quote, payer);
  });
  it("proves rollback in a committed failed local transaction after a successful Raydium CPI", async () => {
    const before = await snapshot(main);
    const s = await swapKeys(provider.connection, main.asset, main.quote, main.pool, payer.publicKey, true);
    const limit = s.data.sqrtPriceX64.muln(99999).divn(100000);
    const ix = await program.methods.swap(true, bn(10000), bn(1), limit).accountsStrict(s.accounts).remainingAccounts(s.ticks).instruction();
    const latest = await provider.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix);
    tx.sign(payer);
    // Only on this guarded local validator: exercise ledger rollback, beyond preflight simulation.
    const signature = await provider.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    const result = await provider.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    expect(result.value.err).not.to.equal(null);
    const landed = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = landed!.meta!.logMessages!.join("\n");
    expect(logs).to.include(`Program ${CLMM.toBase58()} success`);
    expect(logs).to.include("PartialSwap");
    expect(await snapshot(main)).to.deep.equal(before);
  });
  it("swaps A to B through a real nested Raydium CPI signed by Vault PDA", async () => {
    const before = await balances(main);
    forwardSignature = await swap(main, true, 10000n, 9000n);
    const after = await balances(main);
    expect(before.a - after.a).to.equal(10000n); expect(after.b >= 9000n).to.equal(true);
    expect(after.supply).to.equal(before.supply); expect(after.shares).to.equal(before.shares);
    const tx = await provider.connection.getTransaction(forwardSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx!.meta!.err).to.equal(null);
    expect(tx!.meta!.logMessages!.join("\n")).to.include(`Program ${CLMM.toBase58()} invoke [2]`);
    const s = await program.account.strategy.fetch(vaultKeys(main.asset).strategy);
    expect(s.recordedQuoteBalance.toString()).to.equal(after.b.toString()); expect(s.swapCount.toString()).to.equal("1");
  });
  it("rejects end_strategy with outstanding quote assets and recorded exposure", async () => {
    await rejects(main, () => end(main).rpc(), /UnsettledStrategy/);
  });
  it("performs a real reverse swap and accounts for fees instead of restoring the initial balance", async () => {
    const before = await balances(main);
    await swap(main, false, before.b, before.b * 98n / 100n);
    const after = await balances(main);
    expect(after.b).to.equal(0n); expect(after.a > before.a && after.a < 1_000_000n).to.equal(true);
    expect(after.supply).to.equal(1_000_000n); roundTripAssets = after.a;
    expect((await program.account.strategy.fetch(vaultKeys(main.asset).strategy)).recordedQuoteBalance.toString()).to.equal("0");
  });
  it("rejects unlocking after an unsolicited direct quote donation", async () => {
    await transferChecked(provider.connection, payer, getAssociatedTokenAddressSync(main.quote, alice.publicKey), main.quote,
      strategyKeys(main.asset, main.quote, payer.publicKey).quoteVault, alice, 17n, 6);
    await rejects(main, () => end(main).rpc(), /UnsettledStrategy/);
  });
  it("converts all donated quote, then safely ends and clears the lock", async () => {
    await swap(main, false, 17n, 1n);
    await rejects(main, () => end(main, { administrator: outsider.publicKey }).signers([outsider]).rpc(), /ConstraintHasOne/);
    await end(main).rpc();
    expect((await balances(main)).b).to.equal(0n);
    expect((await balances(main)).a > roundTripAssets).to.equal(true);
    expect((await program.account.vaultConfig.fetch(vaultKeys(main.asset).vault)).version).to.equal(1);
    expect((await program.account.strategy.fetch(vaultKeys(main.asset).strategy)).active).to.equal(false);
  });
  it("resumes deposits using the actual post-strategy exchange rate", async () => {
    const before = await balances(main);
    await program.methods.deposit(bn(1000), bn(1)).accountsStrict(userKeys(main.asset, alice.publicKey)).signers([alice]).rpc();
    const after = await balances(main);
    expect(after.a - before.a).to.equal(1000n);
    expect(after.supply - before.supply).to.equal(1000n * before.supply / before.a);
  });
  it("resumes withdrawals using real remaining assets, preserving history", async () => {
    const before = await balances(main);
    const position = userKeys(main.asset, alice.publicKey).position;
    const history = (await program.account.userPosition.fetch(position)).shares.toString();
    await program.methods.withdraw(bn(1000), bn(1)).accountsStrict(userKeys(main.asset, alice.publicKey)).signers([alice]).rpc();
    const after = await balances(main);
    expect(before.a - after.a).to.equal(1000n * before.a / before.supply);
    expect((await program.account.userPosition.fetch(position)).shares.toString()).to.equal(history);
  });
  it("rejects swaps and repeated end when inactive", async () => {
    await rejects(main, () => swap(main, true, 10000n, 1n), /StrategyInactive/);
    await rejects(main, () => end(main).rpc(), /StrategyInactive/);
  });
  it("allows only admin to reactivate the existing strategy and locks users again", async () => {
    await rejects(main, () => start(main, { administrator: outsider.publicKey }).signers([outsider]).rpc(), /ConstraintHasOne/);
    await start(main).rpc();
    await rejects(main, () => start(main).rpc(), /StrategyActive/);
    await rejects(main, () => program.methods.deposit(bn(1), bn(1)).accountsStrict(userKeys(main.asset, alice.publicKey)).signers([alice]).rpc(), /StrategyActive/);
    await end(main).rpc();
  });
  it("adopts a pre-created canonical quote ATA without permitting donation-based unlock", async () => {
    const v = vaultKeys(other.asset);
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, other.quote, v.vault, true);
    await transferChecked(provider.connection, payer, getAssociatedTokenAddressSync(other.quote, alice.publicKey), other.quote, ata.address, alice, 1000n, 6);
    await init(other).rpc();
    expect((await program.account.strategy.fetch(v.strategy)).recordedQuoteBalance.toString()).to.equal("1000");
    await rejects(other, () => end(other).rpc(), /UnsettledStrategy/);
    await swap(other, false, 1000n, 900n);
    await end(other).rpc();
  });
});
