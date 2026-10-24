import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAssociatedTokenAddressSync, MINT_SIZE,
  TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LiquidityVault } from "../target/types/liquidity_vault";

// Fixed Devnet endpoint: ANCHOR_PROVIDER_URL and global Solana config cannot change the network.
const rpcUrl = "https://api.devnet.solana.com";
const programId = new PublicKey("7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH");
const amount = 1_000_000n; // One test token with six decimals.
const root = path.resolve(__dirname, "..");
const repository = fs.realpathSync(path.join(root, ".."));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Receipt {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  status: "pending" | "finalized" | "failed";
  slot?: number;
  broadcastError?: string;
}
interface Balances {
  assets: string;
  supply: string;
  userAssets: string;
  userShares: string;
  positionShares: string;
}
interface RunState {
  version: 1;
  cluster: "devnet";
  programId: string;
  user: string;
  assetMint: string;
  addresses: Record<string, string>;
  stages: Record<string, Receipt>;
  before?: Balances;
  after?: Balances;
}

function outsideRepository(location: string) {
  const relative = path.relative(repository, fs.realpathSync(location));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Wallet and run state must be outside the repository");
  }
}

// Read-only RPC operations may be retried. Transaction broadcasts are never retried here.
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
  if (!walletPath) throw new Error("Set ANCHOR_WALLET to your external Devnet wallet file");
  outsideRepository(walletPath);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const stateDir = path.join(os.homedir(), ".config", "solana", "liquidity_vault", "week9-smoke");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  outsideRepository(stateDir);
  const lockPath = path.join(stateDir, "run.lock");
  const lock = fs.openSync(lockPath, "wx", 0o600);
  const releaseLock = () => { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); };
  process.once("exit", releaseLock);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));

  try {
    const mintPath = path.join(stateDir, "asset-mint-keypair.json");
    if (!fs.existsSync(mintPath)) {
      fs.writeFileSync(mintPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { flag: "wx", mode: 0o600 });
    }
    const mintKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(mintPath, "utf8"))));
    const assetMint = mintKey.publicKey;
    const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
    const vault = pda([Buffer.from("vault"), assetMint.toBuffer()]);
    const shareMint = pda([Buffer.from("share-mint"), vault.toBuffer()]);
    const tokenVault = pda([Buffer.from("token-vault"), vault.toBuffer()]);
    const position = pda([Buffer.from("position"), vault.toBuffer(), payer.publicKey.toBuffer()]);
    const userAssetAccount = getAssociatedTokenAddressSync(assetMint, payer.publicKey);
    const userShareAccount = getAssociatedTokenAddressSync(shareMint, payer.publicKey);
    const addresses = Object.fromEntries(Object.entries({ vault, shareMint, tokenVault, position, userAssetAccount, userShareAccount })
      .map(([name, key]) => [name, key.toBase58()]));
    const statePath = path.join(stateDir, "receipts.json");
    const state: RunState = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : { version: 1, cluster: "devnet", programId: programId.toBase58(), user: payer.publicKey.toBase58(),
        assetMint: assetMint.toBase58(), addresses, stages: {} };
    if (state.version !== 1 || state.cluster !== "devnet" || state.programId !== programId.toBase58()
      || state.user !== payer.publicKey.toBase58() || state.assetMint !== assetMint.toBase58()) {
      throw new Error("Existing run state does not match this wallet, mint and program");
    }
    const save = () => {
      const temporary = `${statePath}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, statePath);
    };
    save();

    const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
    const idl: LiquidityVault = JSON.parse(fs.readFileSync(path.join(root, "target/idl/liquidity_vault.json"), "utf8"));
    const program = new anchor.Program<LiquidityVault>(idl, provider);
    if (!program.programId.equals(programId)) throw new Error("IDL has an unexpected Program ID");
    const onChain = await readRpc(() => connection.getAccountInfo(programId, "finalized"));
    if (!onChain?.executable) throw new Error("Devnet program is not executable");

    async function confirmSaved(name: string, receipt: Receipt) {
      // Even on a resumed run, inspect the saved signature before doing anything else.
      for (let poll = 0; poll < 30; poll++) {
        const result = await readRpc(() => connection.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true }));
        const status = result.value[0];
        if (status?.err) {
          receipt.status = "failed";
          save();
          throw new Error(`${name} failed on chain: ${JSON.stringify(status.err)}; signature=${receipt.signature}`);
        }
        if (status?.confirmationStatus === "finalized") {
          receipt.status = "finalized";
          receipt.slot = status.slot;
          save();
          console.log(`${name}: Finalized ${receipt.signature}`);
          return;
        }
        await delay(3_000);
      }
      throw new Error(`${name}: signature status is not final; no rebroadcast or new transaction was sent. Re-run to check ${receipt.signature}`);
    }

    async function stage(name: string, build: () => Promise<Transaction>, additionalSigners: Keypair[] = []) {
      const previous = state.stages[name];
      if (previous) return confirmSaved(name, previous);
      const tx = await build();
      const latest = await readRpc(() => connection.getLatestBlockhash("confirmed"));
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(payer, ...additionalSigners);
      const receipt: Receipt = {
        signature: anchor.utils.bytes.bs58.encode(tx.signature!), ...latest, status: "pending",
      };
      // Persist the signature BEFORE the one and only broadcast, including on ambiguous RPC failure.
      state.stages[name] = receipt;
      save();
      try {
        const returned = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0,
        });
        if (returned !== receipt.signature) throw new Error("RPC returned a different signature");
      } catch (error) {
        receipt.broadcastError = String(error);
        save();
        console.warn(`${name}: broadcast response uncertain; checking saved signature only`);
      }
      await confirmSaved(name, receipt);
    }

    await stage("create_asset_mint", async () => {
      const lamports = await readRpc(() => connection.getMinimumBalanceForRentExemption(MINT_SIZE));
      return new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: assetMint,
          space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(assetMint, 6, payer.publicKey, null),
      );
    }, [mintKey]);

    await stage("initialize_vault", async () => new Transaction().add(
      await program.methods.initializeVault().accountsStrict({
        administrator: payer.publicKey, assetMint, vault, shareMint, tokenVault,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction(),
    ));

    await stage("prepare_position_and_atas", async () => new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, userAssetAccount, payer.publicKey, assetMint),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, userShareAccount, payer.publicKey, shareMint),
      await program.methods.openPosition().accountsStrict({
        user: payer.publicKey, assetMint, vault, shareMint, tokenVault, position,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction(),
      createMintToInstruction(assetMint, userAssetAccount, payer.publicKey, amount * 2n),
    ));

    async function snapshot(): Promise<Balances> {
      const infos = await readRpc(() => connection.getMultipleAccountsInfo(
        [tokenVault, shareMint, userAssetAccount, userShareAccount, position], "finalized",
      ));
      const userPosition = program.coder.accounts.decode<{ shares: anchor.BN }>("userPosition", infos[4]!.data);
      return {
        assets: unpackAccount(tokenVault, infos[0]).amount.toString(),
        supply: unpackMint(shareMint, infos[1]).supply.toString(),
        userAssets: unpackAccount(userAssetAccount, infos[2]).amount.toString(),
        userShares: unpackAccount(userShareAccount, infos[3]).amount.toString(),
        positionShares: userPosition.shares.toString(),
      };
    }
    if (!state.before) {
      if (state.stages.deposit) throw new Error("Deposit receipt exists without its baseline; refusing to send");
      state.before = await snapshot();
      if (state.before.assets !== "0" || state.before.supply !== "0") {
        throw new Error("The dedicated smoke-test vault is not empty");
      }
      save();
    }
    await stage("deposit", async () => new Transaction().add(
      await program.methods.deposit(new anchor.BN(amount.toString()), new anchor.BN(amount.toString()))
        .accountsStrict({ user: payer.publicKey, assetMint, vault, shareMint, tokenVault, position,
          userAssetAccount, userShareAccount, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    ));
    state.after = await snapshot();
    for (const field of ["assets", "supply", "userShares", "positionShares", "userAssets"] as const) {
      const delta = field === "userAssets" ? -amount : amount;
      if (BigInt(state.after[field]) !== BigInt(state.before[field]) + delta) {
        throw new Error(`Unexpected ${field} delta after finalized deposit`);
      }
    }
    save();
    console.log(JSON.stringify({ cluster: "devnet", programId: programId.toBase58(),
      assetMint: assetMint.toBase58(), ...addresses, before: state.before, after: state.after, receipts: state.stages }, null, 2));
    console.log(`Receipts saved outside the repository: ${statePath}`);
  } finally {
    fs.closeSync(lock);
    releaseLock();
  }
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
