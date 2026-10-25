import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction, createInitializeMint2Instruction, createMintToCheckedInstruction,
  MINT_SIZE, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { ApiV3Token, ClmmInstrument, getPdaProtocolPositionAddress, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { check, CLMM, CONFIG, DECIMALS, INITIAL_SQRT, quotePosition, SUPPLY, TICK_LOWER, TICK_SPACING, TICK_UPPER, WALLET } from "./config";
import { addresses, inspect, verifyPool, verifyPosition, verifyTokens } from "./checks";
import {
  acquireLock, confirmReceipt, connection, createState, externalKey, loadWallet,
  readRpc, readState, saveState, sendOnce, State, STATE_PATH, validateState,
} from "./runtime";

const explorer = (kind: "address" | "tx", value: string) => `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
const publicToken = (address: PublicKey): ApiV3Token => ({ address: address.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
  chainId: 101, decimals: DECIMALS, name: "BEK demo token", symbol: "BEK", logoURI: "", tags: [], extensions: {} });

async function createTokens(rpc: Connection, wallet: Keypair, state: State) {
  const a = addresses(state);
  for (const [name, keyName, mint, ata] of [
    ["mintA", "mint-a", a.mintA, a.ataA], ["mintB", "mint-b", a.mintB, a.ataB],
  ] as const) {
    await sendOnce(rpc, wallet, state, name, async () => {
      check(!await readRpc(() => rpc.getAccountInfo(mint)), "Mint exists without its recorded creation transaction");
      const key = externalKey(keyName);
      check(key.publicKey.equals(mint), "Saved mint key/address mismatch");
      const rent = await readRpc(() => rpc.getMinimumBalanceForRentExemption(MINT_SIZE));
      return { signers: [key], instructions: [
        SystemProgram.createAccount({ fromPubkey: WALLET, newAccountPubkey: mint, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint, DECIMALS, WALLET, null),
        createAssociatedTokenAccountInstruction(WALLET, ata, WALLET, mint),
      ] };
    });
  }
  console.log(JSON.stringify(await verifyTokens(rpc, state, "recorded"), null, 2));
}
async function mintTokens(rpc: Connection, wallet: Keypair, state: State) {
  const a = addresses(state);
  await verifyTokens(rpc, state, "recorded");
  for (const [name, mint, ata] of [["fundA", a.mintA, a.ataA], ["fundB", a.mintB, a.ataB]] as const) {
    await sendOnce(rpc, wallet, state, name, async () => {
      const [mintInfo, ataInfo] = await readRpc(() => rpc.getMultipleAccountsInfo([mint, ata]));
      check(unpackMint(mint, mintInfo).supply === 0n && unpackAccount(ata, ataInfo).amount === 0n, "Refusing to issue tokens twice");
      return { instructions: [createMintToCheckedInstruction(mint, ata, WALLET, SUPPLY, DECIMALS)] };
    });
  }
  console.log(JSON.stringify(await verifyTokens(rpc, state), null, 2));
}
async function createPool(rpc: Connection, wallet: Keypair, state: State) {
  const a = addresses(state);
  await verifyTokens(rpc, state);
  await sendOnce(rpc, wallet, state, "pool", async () => {
    check(!await readRpc(() => rpc.getAccountInfo(a.pool)), "Pool exists without its creation receipt");
    const built = ClmmInstrument.createPoolInstructions({ connection: rpc, programId: CLMM, owner: WALLET,
      mintA: publicToken(a.token0), mintB: publicToken(a.token1), ammConfigId: CONFIG, initialPriceX64: INITIAL_SQRT });
    check(built.address.poolId.equals(a.pool), "SDK derived a different pool");
    return { instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...built.instructions] };
  });
  await verifyPool(rpc, state);
  console.log(`Pool: ${explorer("address", a.pool.toBase58())}`);
}
async function openPosition(rpc: Connection, wallet: Keypair, state: State) {
  const a = addresses(state), quote = quotePosition();
  await verifyTokens(rpc, state);
  await sendOnce(rpc, wallet, state, "position", async () => {
    const { pool, vault0, vault1 } = await verifyPool(rpc, state);
    check(pool.liquidity.isZero() && vault0 === 0n && vault1 === 0n, "Expected an empty new pool");
    const [ata0Info, ata1Info, existingPosition, existingNft] = await readRpc(() => rpc.getMultipleAccountsInfo(
      [a.ata0, a.ata1, a.position, a.nftMint],
    ));
    check(!existingPosition && !existingNft, "Position or NFT already exists without a receipt");
    const wallet0 = unpackAccount(a.ata0, ata0Info).amount, wallet1 = unpackAccount(a.ata1, ata1Info).amount;
    check(wallet0 >= BigInt(quote.maxA.toString()) && wallet1 >= BigInt(quote.maxB.toString()), "Insufficient token balance for slippage limits");
    const nftKey = externalKey("position-nft");
    check(nftKey.publicKey.equals(a.nftMint), "Saved NFT key/address mismatch");
    state.positionBefore = { wallet0: wallet0.toString(), wallet1: wallet1.toString(), vault0: "0", vault1: "0" };
    saveState(state);
    const ix = ClmmInstrument.openPositionWithToken22NftInstruction(
      CLMM, WALLET, a.pool, WALLET, a.nftMint, a.nftAta,
      getPdaProtocolPositionAddress(CLMM, a.pool, TICK_LOWER, TICK_UPPER).publicKey,
      a.tickArrayLower, a.tickArrayUpper, a.position, a.ata0, a.ata1, a.vault0, a.vault1, a.token0, a.token1,
      TICK_LOWER, TICK_UPPER,
      TickArrayUtil.getTickArrayStartIndex(TICK_LOWER, TICK_SPACING),
      TickArrayUtil.getTickArrayStartIndex(TICK_UPPER, TICK_SPACING),
      quote.liquidity, quote.maxA, quote.maxB, true, null,
    );
    return { signers: [nftKey], instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix] };
  });
  state.proof = await verifyPosition(rpc, state);
  saveState(state);
  console.log(JSON.stringify(state.proof, null, 2));
}
async function verify(rpc: Connection, state: State) {
  const required = ["mintA", "mintB", "fundA", "fundB", "pool", "position"];
  for (const name of required) {
    check(state.receipts[name], `Missing ${name} receipt`);
    await confirmReceipt(rpc, state.receipts[name]);
  }
  const proof = await verifyPosition(rpc, state);
  // Verify successful instructions from the actual finalized pool/position transactions.
  for (const [name, instructionName] of [["pool", "create_pool"], ["position", "open_position_with_token22_nft"]]) {
    const tx = await readRpc(() => rpc.getTransaction(state.receipts[name].signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
    check(tx?.meta && tx.meta.err === null, `Missing successful transaction proof: ${name}`);
    const expected = createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
    const accountKeys = tx.transaction.message.getAccountKeys();
    check(tx.transaction.message.compiledInstructions.some((ix) => accountKeys.get(ix.programIdIndex)?.equals(CLMM)
      && Buffer.from(ix.data).subarray(0, 8).equals(expected)), `Wrong Raydium instruction: ${name}`);
  }
  console.log(JSON.stringify({ ...proof, receipts: state.receipts }, null, 2));
  for (const [name, receipt] of Object.entries(state.receipts)) console.log(`${name}: ${explorer("tx", receipt.signature)}`);
  console.log("PASS: finalized tokens, pool, liquidity, ticks and wallet-owned Position NFT; verification sends no transactions.");
}
async function main() {
  const command = process.argv[2];
  check(["inspect", "tokens", "mint", "pool", "position", "verify", "all"].includes(command),
    "Usage: yarn raydium <inspect|tokens|mint|pool|position|verify|all>");
  const rpc = connection();
  console.log(JSON.stringify(await inspect(rpc), null, 2));
  if (command === "inspect") return;
  if (command === "verify") {
    const state = fs.existsSync(STATE_PATH) && process.argv[3] !== "--public-proof" ? readState()
      : validateState(JSON.parse(fs.readFileSync(path.join(__dirname, "devnet-proof.json"), "utf8")));
    await verify(rpc, state);
    return;
  }
  const wallet = loadWallet(), release = acquireLock();
  try {
    check(fs.existsSync(STATE_PATH) || command === "tokens" || command === "all", "Run tokens first");
    const state = fs.existsSync(STATE_PATH) ? readState() : createState();
    for (const [name, address] of [["mint-a", state.mintA], ["mint-b", state.mintB], ["position-nft", state.nftMint]] as const) {
      check(externalKey(name).publicKey.toBase58() === address, "External key does not match saved project address");
    }
    // Resolve any interrupted earlier step before evaluating its resulting balances.
    for (const receipt of Object.values(state.receipts)) {
      try { await confirmReceipt(rpc, receipt); } finally { saveState(state); }
    }
    if (command === "tokens" || command === "all") await createTokens(rpc, wallet, state);
    if (command === "mint" || command === "all") await mintTokens(rpc, wallet, state);
    if (command === "pool" || command === "all") await createPool(rpc, wallet, state);
    if (command === "position" || command === "all") await openPosition(rpc, wallet, state);
    if (command === "all") await verify(rpc, state);
  } finally { release(); }
}
main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
