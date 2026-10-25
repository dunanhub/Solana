import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { PoolInfoLayout, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { CLMM, CONFIG, WALLET, check, checkConfig, checkNetwork } from "../raydium/config";
import { connection, loadWallet, outsideRepository, readRpc, Receipt } from "../raydium/runtime";
import { VAULT_PROGRAM, vaultKeys, userKeys, strategyKeys, manageKeys, swapKeys, ASSOCIATED_TOKEN_PROGRAM_ID } from "./client";
import { sendStep, retireExpiredStep, Journal } from "./journal";
import { LiquidityVault } from "../../target/types/liquidity_vault";

const A = new PublicKey("9fCGeyDFz86XXhUgT7c9zj4qYVBqrnc6B58Fcvv6zzhP");
const B = new PublicKey("FGWg89P3tk45pxLHCy8u1A564jPaVHCJjJnk923iKhyG");
const POOL = new PublicKey("CuATcxQ3yxU8MPtp7uiYkZdgYxyBZhNuPwf39XK81A2b");
const NFT = new PublicKey("AKbjsHiFyGFLsWB2KRA9Lccbc8Wbzn7oVkT9yDoPajci");
const LP = new PublicKey("8Y3rCCZrTTSBaShqtNNPwJ8Xxw2EJcg46rCfG8LgDkj7");
const OLD_ASSET = new PublicKey("97EfbGqcFVi2MsVtfcGcDYdxzfBaGUx5H6YzCMtbfe5S");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const root = path.resolve(__dirname, "../..");
const dir = path.join(os.homedir(), ".config/solana/liquidity_vault/week12-strategy");
const statePath = path.join(dir, "state.json");
const rpc = connection();
const v = vaultKeys(A), u = userKeys(A, WALLET), s = strategyKeys(A, B, WALLET);
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bn = (n: string | bigint | number) => new anchor.BN(n.toString());
const compute = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
const idl: LiquidityVault = JSON.parse(fs.readFileSync(path.join(root, "target/idl/liquidity_vault.json"), "utf8"));
interface Snapshot { a: string; b: string; supply: string; userA: string; userB: string; userShares: string;
  history: string; version: number | null; active: boolean | null; recordedB: string | null; swaps: string | null }
interface RunState extends Journal { version: 1; cluster: "devnet"; program: string; wallet: string; pool: string;
  binaryHash: string; baseline: Record<string, string>; receipts: Record<string, Receipt>;
  guards?: Record<string, { code: string; number: number; logs: string[] }>;
  snapshots: Record<string, Snapshot>; swaps: Record<string, { amount: string; minimum: string; limit: string; simulatedOutput: string }> }
function persist(state: RunState) {
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(`${statePath}.tmp`, statePath);
}
async function protectedAccounts() {
  const old = vaultKeys(OLD_ASSET), oldUser = userKeys(OLD_ASSET, WALLET);
  const keys = [old.vault, old.tokenVault, old.shareMint, oldUser.position, oldUser.userAssetAccount,
    oldUser.userShareAccount, LP, getAssociatedTokenAddressSync(NFT, WALLET, false, TOKEN_2022_PROGRAM_ID), A, B];
  const infos = await readRpc(() => rpc.getMultipleAccountsInfo(keys));
  return Object.fromEntries(keys.map((key, i) => {
    check(infos[i], `Missing protected account ${key}`);
    return [key.toBase58(), hash(Buffer.concat([infos[i]!.owner.toBuffer(), infos[i]!.data]))];
  }));
}
async function inspect() {
  checkNetwork(rpc.rpcEndpoint, await readRpc(() => rpc.getGenesisHash()), CLMM);
  const programInfo = await readRpc(() => rpc.getAccountInfo(VAULT_PROGRAM));
  check(programInfo !== null && programInfo.owner.equals(LOADER) && programInfo.executable && programInfo.data.readUInt32LE(0) === 2, "Wrong Vault executable");
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const [data, poolInfo, configInfo, mintA, mintB, lp, nft] = await readRpc(() => rpc.getMultipleAccountsInfo([
    programDataAddress, POOL, CONFIG, A, B, LP, getAssociatedTokenAddressSync(NFT, WALLET, false, TOKEN_2022_PROGRAM_ID)]));
  check(data !== null && data.owner.equals(LOADER) && data.data.readUInt32LE(0) === 3 && data.data[12] === 1
    && new PublicKey(data.data.subarray(13, 45)).equals(WALLET), "Wrong upgrade authority");
  checkConfig(CONFIG, configInfo);
  check(poolInfo !== null && poolInfo.owner.equals(CLMM) && poolInfo.data.length === PoolInfoLayout.span, "Wrong pool");
  const pool = PoolInfoLayout.decode(poolInfo.data);
  check(pool.creator.equals(WALLET) && pool.configId.equals(CONFIG) && pool.mintA.equals(A) && pool.mintB.equals(B)
    && pool.liquidity.toString() === "338374998", "Pool pair/creator/liquidity changed");
  for (const [key, info] of [[A, mintA], [B, mintB]] as const) {
    check(info, "Missing mint");
    const mint = unpackMint(key, info);
    check(mint.decimals === 6 && mint.supply === 100_000_000n && mint.mintAuthority?.equals(WALLET)
      && mint.freezeAuthority === null, "Unexpected mint configuration");
  }
  check(lp?.owner.equals(CLMM) && PersonalPositionLayout.decode(lp.data).liquidity.toString() === "338374998", "Manual LP changed");
  check(nft, "Missing manual NFT");
  const nftAccount = unpackAccount(getAssociatedTokenAddressSync(NFT, WALLET, false, TOKEN_2022_PROGRAM_ID), nft, TOKEN_2022_PROGRAM_ID);
  check(nftAccount.owner.equals(WALLET) && nftAccount.amount === 1n, "Week 11 NFT must remain wallet-owned");
  const binary = fs.readFileSync(path.join(root, "target/deploy/liquidity_vault.so"));
  const deployed = data.data.subarray(45);
  const binaryMatches = deployed.length >= binary.length && deployed.subarray(0, binary.length).equals(binary)
    && deployed.subarray(binary.length).every((b) => b === 0);
  const [balance, bufferRent, targetRent] = await Promise.all([
    readRpc(() => rpc.getBalance(WALLET)), readRpc(() => rpc.getMinimumBalanceForRentExemption(binary.length + 37)),
    readRpc(() => rpc.getMinimumBalanceForRentExemption(Math.max(binary.length + 45, data.data.length)))]);
  const old = vaultKeys(OLD_ASSET);
  const balanceKeys = [u.userAssetAccount, getAssociatedTokenAddressSync(B, WALLET), pool.vaultA, pool.vaultB,
    v.tokenVault, s.quoteVault, old.tokenVault, old.shareMint, v.vault];
  const balanceInfo = await readRpc(() => rpc.getMultipleAccountsInfo(balanceKeys));
  const amount = (i: number) => balanceInfo[i] ? unpackAccount(balanceKeys[i], balanceInfo[i]!).amount.toString() : null;
  return { checkedAt: new Date().toISOString(), cluster: "devnet", wallet: WALLET.toBase58(), balanceLamports: balance, binaryBytes: binary.length,
    binaryHash: hash(binary), binaryMatches, programData: programDataAddress.toBase58(),
    deployedSlot: data.data.readBigUInt64LE(4).toString(),
    upgradePeakLamports: bufferRent + Math.max(0, targetRent - data.lamports) + 50_000_000,
    pool: POOL.toBase58(), tick: pool.tickCurrent, sqrtPriceX64: pool.sqrtPriceX64.toString(),
    balances: { walletA: amount(0), walletB: amount(1), poolA: amount(2), poolB: amount(3),
      newVaultA: amount(4), newVaultB: amount(5), oldVaultAssets: amount(6),
      oldVaultSupply: balanceInfo[7] ? unpackMint(old.shareMint, balanceInfo[7]!).supply.toString() : null },
    bekVaultExists: balanceInfo[8] !== null,
    addresses: Object.fromEntries(Object.entries({ ...v, quoteVault: s.quoteVault, position: u.position }).map(([k, value]) => [k, value.toBase58()])) };
}
async function snapshot(program: anchor.Program<LiquidityVault>): Promise<Snapshot> {
  const keys = [v.tokenVault, s.quoteVault, v.shareMint, u.userAssetAccount,
    getAssociatedTokenAddressSync(B, WALLET), u.userShareAccount, u.position, v.vault, v.strategy];
  const info = await readRpc(() => rpc.getMultipleAccountsInfo(keys));
  const amount = (i: number) => info[i] ? unpackAccount(keys[i], info[i]!).amount.toString() : "0";
  const strategy = info[8] ? program.coder.accounts.decode("strategy", info[8]!.data) : null;
  return { a: amount(0), b: amount(1), supply: info[2] ? unpackMint(v.shareMint, info[2]!).supply.toString() : "0",
    userA: amount(3), userB: amount(4), userShares: amount(5),
    history: info[6] ? program.coder.accounts.decode("userPosition", info[6]!.data).shares.toString() : "0",
    version: info[7] ? program.coder.accounts.decode("vaultConfig", info[7]!.data).version : null,
    active: strategy?.active ?? null, recordedB: strategy?.recordedQuoteBalance.toString() ?? null,
    swaps: strategy?.swapCount.toString() ?? null };
}
async function verifyCpi(program: anchor.Program<LiquidityVault>, state: RunState, name: string, aToB: boolean) {
  const receipt = state.receipts[name];
  check(receipt?.status === "finalized", `Missing finalized ${name}`);
  const tx = await readRpc(() => rpc.getParsedTransaction(receipt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
  check(tx?.meta && tx.meta.err === null, `Missing successful ${name} transaction`);
  const groups = tx.meta.innerInstructions ?? [];
  const group = groups.find((g) => g.instructions.some((ix) => ix.programId.equals(CLMM)));
  check(group && tx.transaction.message.instructions[group.index].programId.equals(VAULT_PROGRAM), "CLMM must be an inner call of Vault");
  const inner = group.instructions.find((ix) => ix.programId.equals(CLMM));
  const height = (ix: unknown) => (ix as { stackHeight?: number }).stackHeight;
  check(inner && "accounts" in inner && "data" in inner && height(inner) === 2, "Missing Raydium CPI at stack height 2");
  const wire = anchor.utils.bytes.bs58.decode(inner.data);
  const quote = state.swaps[name];
  check(wire.length === 41 && wire.subarray(0, 8).equals(Buffer.from([43, 4, 237, 11, 26, 201, 30, 98]))
    && wire.readBigUInt64LE(8).toString() === quote.amount && wire.readBigUInt64LE(16).toString() === quote.minimum
    && (wire.readBigUInt64LE(24) + (wire.readBigUInt64LE(32) << 64n)).toString() === quote.limit
    && wire[40] === 1, "Wrong SwapV2 data");
  check(inner.accounts[0].equals(v.vault) && inner.accounts[2].equals(POOL)
    && inner.accounts[3].equals(aToB ? v.tokenVault : s.quoteVault)
    && inner.accounts[4].equals(aToB ? s.quoteVault : v.tokenVault), "Wrong CPI authority/source/destination");
  check(!tx.transaction.message.accountKeys.find((k) => k.pubkey.equals(v.vault))?.signer, "Vault PDA must not be a transaction signer");
  const events = [...new anchor.EventParser(VAULT_PROGRAM, program.coder).parseLogs(tx.meta.logMessages ?? [])];
  const event = events.find((e) => e.name === "strategySwapEvent");
  check(event && event.data.spent.toString() === quote.amount && BigInt(event.data.received.toString()) >= BigInt(quote.minimum), "Missing verified swap event");
  const transfers = group.instructions.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && "parsed" in ix
    && ix.parsed.type === "transferChecked");
  check(transfers.length === 2 && transfers.every((ix) => height(ix) === 3), "Expected two nested SPL Token transfers");
  const transferInfo = transfers.map((ix) => {
    check("parsed" in ix, "Missing parsed SPL transfer"); return ix.parsed.info;
  });
  check(transferInfo.some((i) => i.authority === v.vault.toBase58()
    && i.source === inner.accounts[3].toBase58() && i.destination === inner.accounts[5].toBase58()
    && i.mint === (aToB ? A : B).toBase58() && i.tokenAmount.amount === quote.amount), "Wrong input token CPI");
  check(transferInfo.some((i) => i.authority === POOL.toBase58()
    && i.source === inner.accounts[6].toBase58() && i.destination === inner.accounts[4].toBase58()
    && i.mint === (aToB ? B : A).toBase58() && i.tokenAmount.amount === event.data.received.toString()), "Wrong output token CPI");
  return { signature: receipt.signature, explorer: `https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`,
    slot: receipt.slot, cpiAuthority: v.vault.toBase58(), stackHeight: height(inner),
    spent: event.data.spent.toString(), received: event.data.received.toString(), tokenTransfers: transfers };
}
async function main() {
  const command = process.argv[2] ?? "check";
  check(["check", "run", "verify", "recover-expired-deposit"].includes(command), "Use check, run, verify or recover-expired-deposit");
  const deployment = await inspect();
  console.log(JSON.stringify(deployment, null, 2));
  if (command === "check") {
    if (process.argv.includes("--save-status")) fs.writeFileSync(path.join(__dirname, "devnet-status.json"),
      JSON.stringify({ ...deployment, note: "Read-only check, not proof of Week 12 transactions" }, null, 2) + "\n");
    return;
  }
  check(deployment.binaryMatches, "Upgrade and verify the local binary before running Week 12");
  const wallet = loadWallet();
  const program = new anchor.Program<LiquidityVault>(idl, new anchor.AnchorProvider(rpc, new anchor.Wallet(wallet),
    { commitment: "finalized", preflightCommitment: "confirmed", skipPreflight: false }));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); outsideRepository(dir);
  const lockPath = path.join(dir, "run.lock"), fd = fs.openSync(lockPath, "wx", 0o600);
  const release = () => { if (fs.existsSync(lockPath)) { fs.closeSync(fd); fs.unlinkSync(lockPath); } };
  process.once("exit", release);
  process.once("SIGINT", () => process.exit(130)); process.once("SIGTERM", () => process.exit(143));
  try {
    let state: RunState;
    if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    else {
      check(command === "run", "No Week 12 journal to verify");
      check(!(await readRpc(() => rpc.getAccountInfo(v.vault))), "Unexpected existing BEK Vault: reconcile before starting");
      state = { version: 1, cluster: "devnet", program: VAULT_PROGRAM.toBase58(), wallet: WALLET.toBase58(), pool: POOL.toBase58(),
        binaryHash: deployment.binaryHash, baseline: await protectedAccounts(), receipts: {}, snapshots: { before: await snapshot(program) }, swaps: {} };
      persist(state);
    }
    check(state.version === 1 && state.cluster === "devnet" && state.program === VAULT_PROGRAM.toBase58()
      && state.wallet === WALLET.toBase58() && state.pool === POOL.toBase58() && state.binaryHash === deployment.binaryHash,
    "Unexpected saved strategy journal");
    const unchanged = async () => check(JSON.stringify(await protectedAccounts()) === JSON.stringify(state.baseline), "Protected Week 9/11 accounts changed");
    await unchanged();
    if (command === "recover-expired-deposit") {
      check(state.receipts.endStrategy?.status === "finalized" && !state.snapshots.depositAfterEnd,
        "Recovery is limited to the uncompleted post-end deposit");
      check(JSON.stringify(await snapshot(program)) === JSON.stringify(state.snapshots.endStrategy),
        "Balances changed since end_strategy; reconcile manually");
      await retireExpiredStep(rpc, state, "depositAfterEnd", () => persist(state));
      console.log(JSON.stringify({ recovered: "depositAfterEnd", retired: state.retired }, null, 2));
      return;
    }
    async function step(name: string, build: () => Promise<TransactionInstruction[]>, validate?: (after: Snapshot) => void) {
      if (state.snapshots[name]) { check(state.receipts[name]?.status === "finalized", "Snapshot without finalized receipt"); return; }
      check(command === "run", `Incomplete step ${name}`);
      check(await readRpc(() => rpc.getBalance(WALLET)) >= 50_000_000, "Need at least 0.05 test SOL for accounts/fees");
      await sendStep(rpc, wallet, state, name, build, () => persist(state));
      const after = await snapshot(program); if (validate) validate(after);
      state.snapshots[name] = after; persist(state); await unchanged();
      // Public Devnet limits new HTTP connections as well as requests. Pace stages.
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    }
    const { strategy: _strategy, ...base } = v;
    await step("initializeVault", async () => [await program.methods.initializeVault().accountsStrict({ ...base,
      administrator: WALLET, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()]);
    await step("openPosition", async () => [createAssociatedTokenAccountIdempotentInstruction(WALLET, u.userShareAccount, WALLET, v.shareMint),
      await program.methods.openPosition().accountsStrict({ ...base, user: WALLET, position: u.position,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()]);
    await step("deposit", async () => [await program.methods.deposit(bn(1_000_000), bn(1_000_000)).accountsStrict(u).instruction()],
      (a) => check(a.a === "1000000" && a.supply === "1000000", "Unexpected initial deposit"));
    await step("initializeStrategy", async () => [await program.methods.initializeStrategy().accountsStrict({ ...s,
      pool: POOL, raydiumProgram: CLMM, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()],
      (a) => check(a.active && a.version === 129 && a.b === "0", "Unexpected strategy activation"));
    if (command === "run" && !state.receipts.forward) {
      for (const [name, method] of [["deposit", program.methods.deposit(bn(1), bn(1))],
        ["withdraw", program.methods.withdraw(bn(1), bn(1))]] as const) {
        let rejected = false;
        try { await method.accountsStrict(u).simulate(); } catch (e) {
          const error = e as { logs?: string[]; simulationResponse?: { logs?: string[] } };
          const logs = error.logs ?? error.simulationResponse?.logs ?? [];
          const parsed = anchor.AnchorError.parse(logs);
          rejected = parsed?.error.errorCode.code === "StrategyActive" && parsed.error.errorCode.number === 6011;
          check(rejected, `Unexpected ${name} simulation failure: ${String(e)}\n${logs.join("\n")}`);
          state.guards ??= {};
          state.guards[name] = { code: parsed!.error.errorCode.code, number: parsed!.error.errorCode.number, logs };
          persist(state);
        }
        check(rejected, `${name} was not blocked by StrategyActive`);
      }
    }
    async function swapStep(name: string, aToB: boolean) {
      await step(name, async () => {
        const before = await snapshot(program);
        const amount = aToB ? 10_000n : BigInt(before.b); check(amount > 0n, "Empty swap input");
        const keys = await swapKeys(rpc, A, B, POOL, WALLET, aToB);
        const method = (min: bigint) => program.methods.swap(aToB, bn(amount), bn(min), keys.limit)
          .accountsStrict(keys.accounts).remainingAccounts(keys.ticks).preInstructions([compute]);
        const simulated = await method(1n).simulate();
        const event = simulated.events.find((e) => e.name === "strategySwapEvent");
        check(event, "Simulation did not return a Vault swap event");
        const output = BigInt(event.data.received.toString()), minimum = output * 99n / 100n;
        check(minimum > 0n, "Quote too small");
        state.swaps[name] = { amount: amount.toString(), minimum: minimum.toString(), limit: keys.limit.toString(), simulatedOutput: output.toString() };
        persist(state);
        return [compute, await method(minimum).instruction()];
      }, (after) => {
        check(after.active && after.version === 129 && after.supply === "1000000" && after.userShares === "1000000", "Swap altered shares/lock");
        if (aToB) check(after.a === "990000" && BigInt(after.b) > 0n && after.recordedB === after.b, "Wrong forward balance delta");
        else check(after.b === "0" && after.recordedB === "0" && BigInt(after.a) > 990000n, "Reverse did not settle quote balance");
      });
    }
    await swapStep("forward", true); await swapStep("reverse", false);
    await step("endStrategy", async () => [await program.methods.endStrategy().accountsStrict(manageKeys(A, B, WALLET)).instruction()],
      (a) => check(a.active === false && a.version === 1 && a.b === "0" && a.recordedB === "0", "Unsafe end state"));
    await step("depositAfterEnd", async () => {
      const before = await snapshot(program), shares = 1000n * BigInt(before.supply) / BigInt(before.a);
      return [await program.methods.deposit(bn(1000), bn(shares)).accountsStrict(u).instruction()];
    });
    await step("withdrawAfterEnd", async () => {
      const before = await snapshot(program), assets = 1000n * BigInt(before.a) / BigInt(before.supply);
      return [await program.methods.withdraw(bn(1000), bn(assets)).accountsStrict(u).instruction()];
    });
    const current = await snapshot(program);
    const receipts = Object.values(state.receipts);
    const statuses = (await readRpc(() => rpc.getSignatureStatuses(receipts.map((r) => r.signature), { searchTransactionHistory: true }))).value;
    check(statuses.every((status, i) => status?.confirmationStatus === "finalized" && status.err === null
      && status.slot === receipts[i].slot), "A saved receipt is not finalized on-chain");
    check(state.guards?.deposit.code === "StrategyActive" && state.guards?.withdraw.code === "StrategyActive", "Missing active-strategy guard proof");
    check(JSON.stringify(current) === JSON.stringify(state.snapshots.withdrawAfterEnd), "Final balances differ from recorded result");
    check(current.active === false && current.b === "0" && current.recordedB === "0" && current.swaps === "2" && current.version === 1, "Unsafe final state");
    check(state.snapshots.depositAfterEnd.history === current.history && BigInt(state.snapshots.depositAfterEnd.a) === BigInt(state.snapshots.endStrategy.a) + 1000n
      && BigInt(current.userShares) === BigInt(state.snapshots.depositAfterEnd.userShares) - 1000n, "Post-end deposit/withdraw proof mismatch");
    const cpi = [await verifyCpi(program, state, "forward", true), await verifyCpi(program, state, "reverse", false)];
    await unchanged();
    const proof = { ...state, verifiedAt: new Date().toISOString(), deployment, cpi, current,
      links: Object.fromEntries(Object.entries(state.receipts).map(([k, r]) => [k, `https://explorer.solana.com/tx/${r.signature}?cluster=devnet`])) };
    fs.writeFileSync(path.join(__dirname, "devnet-proof.json"), JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify({ verified: true, current, cpi }, null, 2));
  } finally { release(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
