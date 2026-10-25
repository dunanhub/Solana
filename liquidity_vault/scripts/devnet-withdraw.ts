import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LiquidityVault } from "../target/types/liquidity_vault";

const rpcUrl = "https://api.devnet.solana.com";
const programId = new PublicKey("7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH");
const sharesToBurn = 250_000n;
const root = path.resolve(__dirname, "..");
const repository = fs.realpathSync(path.join(root, ".."));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Snapshot {
  assets: string;
  supply: string;
  userAssets: string;
  userShares: string;
  historicalShares: string;
  positionData: string;
}
interface Receipt {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  status: "pending" | "finalized" | "failed";
  slot?: number;
  broadcastError?: string;
}
interface RunState {
  version: 1;
  cluster: "devnet";
  programId: string;
  user: string;
  assetMint: string;
  addresses: Record<string, string>;
  sharesToBurn: string;
  minAssetsOut: string;
  before: Snapshot;
  receipt?: Receipt;
  after?: Snapshot;
}

function outsideRepository(location: string) {
  const relative = path.relative(repository, fs.realpathSync(location));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Wallet and receipt storage must be outside the repository");
  }
}

async function readRpc<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (attempt >= 3 || !/429|Too Many Requests|fetch failed|timed? ?out|ECONNRESET/i.test(String(error))) throw error;
      await delay(2_000 * 2 ** attempt);
    }
  }
}

async function main() {
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error("Set ANCHOR_WALLET to the external Week 9 Devnet wallet");
  outsideRepository(walletPath);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const projectState = path.join(os.homedir(), ".config", "solana", "liquidity_vault");
  const week9 = JSON.parse(fs.readFileSync(path.join(projectState, "week9-smoke", "receipts.json"), "utf8"));
  if (week9.cluster !== "devnet" || week9.programId !== programId.toBase58() || week9.user !== payer.publicKey.toBase58()) {
    throw new Error("Week 9 receipts do not describe this wallet and Devnet program");
  }
  const assetMint = new PublicKey(week9.assetMint);
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const vault = pda([Buffer.from("vault"), assetMint.toBuffer()]);
  const shareMint = pda([Buffer.from("share-mint"), vault.toBuffer()]);
  const tokenVault = pda([Buffer.from("token-vault"), vault.toBuffer()]);
  const position = pda([Buffer.from("position"), vault.toBuffer(), payer.publicKey.toBuffer()]);
  const userAssetAccount = getAssociatedTokenAddressSync(assetMint, payer.publicKey);
  const userShareAccount = getAssociatedTokenAddressSync(shareMint, payer.publicKey);
  const addresses = Object.fromEntries(Object.entries({ vault, shareMint, tokenVault, position, userAssetAccount, userShareAccount })
    .map(([name, address]) => [name, address.toBase58()]));
  for (const [name, address] of Object.entries(addresses)) {
    if (week9.addresses[name] !== address) throw new Error(`Unexpected Week 9 ${name}`);
  }

  const stateDir = path.join(projectState, "week10-smoke");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  outsideRepository(stateDir);
  const statePath = path.join(stateDir, "receipts.json");
  const lockPath = path.join(stateDir, "run.lock");
  const lock = fs.openSync(lockPath, "wx", 0o600);
  const releaseLock = () => { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); };
  process.once("exit", releaseLock);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  try {
    const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
      commitment: "confirmed", preflightCommitment: "confirmed", skipPreflight: false,
    });
    const idl: LiquidityVault = JSON.parse(fs.readFileSync(path.join(root, "target/idl/liquidity_vault.json"), "utf8"));
    const program = new anchor.Program<LiquidityVault>(idl, provider);
    if (!program.programId.equals(programId)) throw new Error("Unexpected IDL Program ID");
    const executable = await readRpc(() => connection.getAccountInfo(programId, "finalized"));
    if (!executable?.executable) throw new Error("Devnet program is not executable");

    async function snapshot(): Promise<Snapshot> {
      const infos = await readRpc(() => connection.getMultipleAccountsInfo(
        [vault, shareMint, tokenVault, position, userAssetAccount, userShareAccount], "finalized",
      ));
      if (!infos[0]?.owner.equals(programId) || !infos[3]?.owner.equals(programId)) {
        throw new Error("Unexpected Vault or position owner");
      }
      const config = program.coder.accounts.decode<{ administrator: PublicKey; assetMint: PublicKey; shareMint: PublicKey; tokenVault: PublicKey }>("vaultConfig", infos[0].data);
      const userPosition = program.coder.accounts.decode<{ user: PublicKey; vault: PublicKey; shares: anchor.BN }>("userPosition", infos[3].data);
      const mint = unpackMint(shareMint, infos[1]);
      const assets = unpackAccount(tokenVault, infos[2]);
      const userAssets = unpackAccount(userAssetAccount, infos[4]);
      const userShares = unpackAccount(userShareAccount, infos[5]);
      if (!config.administrator.equals(payer.publicKey) || !config.assetMint.equals(assetMint)
        || !config.shareMint.equals(shareMint) || !config.tokenVault.equals(tokenVault)
        || !userPosition.user.equals(payer.publicKey) || !userPosition.vault.equals(vault)
        || !mint.mintAuthority?.equals(vault) || !assets.owner.equals(vault) || !assets.mint.equals(assetMint)
        || !userAssets.owner.equals(payer.publicKey) || !userAssets.mint.equals(assetMint)
        || !userShares.owner.equals(payer.publicKey) || !userShares.mint.equals(shareMint)) {
        throw new Error("Week 9 account relationships do not match this test vault and wallet");
      }
      return { assets: assets.amount.toString(), supply: mint.supply.toString(),
        userAssets: userAssets.amount.toString(), userShares: userShares.amount.toString(),
        historicalShares: userPosition.shares.toString(), positionData: infos[3].data.toString("base64") };
    }

    let state: RunState;
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.version !== 1 || state.cluster !== "devnet" || state.programId !== programId.toBase58()
        || state.user !== payer.publicKey.toBase58() || state.assetMint !== assetMint.toBase58()
        || state.sharesToBurn !== sharesToBurn.toString()) throw new Error("Saved withdrawal has different parameters");
    } else {
      const before = await snapshot();
      const assets = BigInt(before.assets), supply = BigInt(before.supply);
      if (assets === 0n || supply === 0n || BigInt(before.userShares) < sharesToBurn || supply < sharesToBurn) {
        throw new Error("The existing Week 9 vault/share balance is not suitable for this withdrawal");
      }
      const minimum = sharesToBurn === supply ? assets : sharesToBurn * assets / supply;
      if (minimum === 0n) throw new Error("Withdrawal would return zero assets");
      state = { version: 1, cluster: "devnet", programId: programId.toBase58(), user: payer.publicKey.toBase58(),
        assetMint: assetMint.toBase58(), addresses, sharesToBurn: sharesToBurn.toString(), minAssetsOut: minimum.toString(), before };
    }
    const save = () => {
      fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(`${statePath}.tmp`, statePath);
    };
    save();

    if (!state.receipt) {
      const latest = await readRpc(() => connection.getLatestBlockhash("confirmed"));
      const ix = await program.methods.withdraw(new anchor.BN(state.sharesToBurn), new anchor.BN(state.minAssetsOut))
        .accountsStrict({ user: payer.publicKey, assetMint, vault, shareMint, tokenVault, position,
          userAssetAccount, userShareAccount, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
      const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(ix);
      tx.sign(payer);
      state.receipt = { signature: anchor.utils.bytes.bs58.encode(tx.signature!), ...latest, status: "pending" };
      // Save before broadcasting. An uncertain response must never create a second withdrawal.
      save();
      console.log(`Saved withdrawal signature: ${state.receipt.signature}`);
      try {
        const returned = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0,
        });
        if (returned !== state.receipt.signature) throw new Error("RPC returned an unexpected signature");
      } catch (error) {
        state.receipt.broadcastError = String(error);
        save();
        console.warn("Broadcast response uncertain; checking the saved signature, without resending");
      }
    }

    for (let poll = 0; poll < 30; poll++) {
      const result = await readRpc(() => connection.getSignatureStatuses([state.receipt!.signature], { searchTransactionHistory: true }));
      const status = result.value[0];
      if (status?.err) {
        state.receipt.status = "failed";
        save();
        throw new Error(`Withdrawal failed on chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === "finalized") {
        state.receipt.status = "finalized";
        state.receipt.slot = status.slot;
        save();
        break;
      }
      if (poll === 29) throw new Error(`Withdrawal status unresolved: ${state.receipt.signature}; re-run to check only, no resubmission`);
      await delay(3_000);
    }
    const executed = await readRpc(() => connection.getParsedTransaction(state.receipt!.signature, {
      commitment: "finalized", maxSupportedTransactionVersion: 0,
    }));
    // Devnet's Token implementation may omit instruction-name log lines.
    // Verify the actual ordered inner instructions and their parameters instead.
    const inner = executed?.meta?.innerInstructions?.filter((group) => group.index === 0)
      .flatMap((group) => group.instructions) ?? [];
    if (!executed?.meta || executed.meta.err || inner.length !== 2
      || !inner[0].programId.equals(TOKEN_PROGRAM_ID) || !inner[1].programId.equals(TOKEN_PROGRAM_ID)
      || !("parsed" in inner[0]) || !("parsed" in inner[1])) {
      throw new Error("Missing successful burn/transfer proof for the saved withdrawal");
    }
    const burned = inner[0].parsed;
    const transferred = inner[1].parsed;
    if (burned.type !== "burn" || burned.info.amount !== state.sharesToBurn
      || burned.info.account !== userShareAccount.toBase58() || burned.info.mint !== shareMint.toBase58()
      || burned.info.authority !== payer.publicKey.toBase58()
      || transferred.type !== "transferChecked" || transferred.info.tokenAmount.amount !== state.minAssetsOut
      || transferred.info.source !== tokenVault.toBase58() || transferred.info.mint !== assetMint.toBase58()
      || transferred.info.destination !== userAssetAccount.toBase58() || transferred.info.authority !== vault.toBase58()) {
      throw new Error("Saved withdrawal has unexpected CPI types, amounts or accounts");
    }
    state.after = await snapshot();
    const out = BigInt(state.minAssetsOut);
    const deltas = { assets: -out, supply: -sharesToBurn, userAssets: out, userShares: -sharesToBurn };
    for (const field of ["assets", "supply", "userAssets", "userShares"] as const) {
      if (BigInt(state.after[field]) !== BigInt(state.before[field]) + deltas[field]) throw new Error(`Unexpected ${field} delta`);
    }
    if (state.after.positionData !== state.before.positionData || state.after.historicalShares !== state.before.historicalShares) {
      throw new Error("Historical UserPosition changed during withdraw");
    }
    save();
    console.log(JSON.stringify(state, null, 2));
    console.log(`Explorer: https://explorer.solana.com/tx/${state.receipt.signature}?cluster=devnet`);
    console.log(`Receipt saved outside the repository: ${statePath}`);
  } finally {
    fs.closeSync(lock);
    releaseLock();
  }
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
