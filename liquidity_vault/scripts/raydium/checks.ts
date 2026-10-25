import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import {
  PoolInfoLayout, PersonalPositionLayout, TickArrayLayout, ObservationLayout, TickArrayBitmapExtensionLayout,
  TickArrayUtil, TickUtil, getPdaPoolId, getPdaPoolVaultId, getPdaObservationAccount, getPdaExBitmapAccount,
  getPdaPersonalPositionAddress, getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk-v2";
import {
  accountData, check, checkConfig, checkNetwork, CLMM, CONFIG, DECIMALS, INITIAL_SQRT,
  orderedMints, quotePosition, SUPPLY, TICK_LOWER, TICK_SPACING, TICK_UPPER, WALLET,
} from "./config";
import { readRpc, State } from "./runtime";

export function addresses(state: State) {
  const mintA = new PublicKey(state.mintA), mintB = new PublicKey(state.mintB), nftMint = new PublicKey(state.nftMint);
  const [token0, token1] = orderedMints(mintA, mintB);
  check(!nftMint.equals(token0) && !nftMint.equals(token1), "Position NFT must have a separate mint");
  const pool = getPdaPoolId(CLMM, CONFIG, token0, token1).publicKey;
  return { mintA, mintB, nftMint, token0, token1, pool,
    ataA: getAssociatedTokenAddressSync(mintA, WALLET), ataB: getAssociatedTokenAddressSync(mintB, WALLET),
    ata0: getAssociatedTokenAddressSync(token0, WALLET), ata1: getAssociatedTokenAddressSync(token1, WALLET),
    vault0: getPdaPoolVaultId(CLMM, pool, token0).publicKey,
    vault1: getPdaPoolVaultId(CLMM, pool, token1).publicKey,
    observation: getPdaObservationAccount(CLMM, pool).publicKey,
    bitmap: getPdaExBitmapAccount(CLMM, pool).publicKey,
    position: getPdaPersonalPositionAddress(CLMM, nftMint).publicKey,
    nftAta: getAssociatedTokenAddressSync(nftMint, WALLET, false, TOKEN_2022_PROGRAM_ID),
    tickArrayLower: getPdaTickArrayAddress(CLMM, pool, TickArrayUtil.getTickArrayStartIndex(TICK_LOWER, TICK_SPACING)).publicKey,
    tickArrayUpper: getPdaTickArrayAddress(CLMM, pool, TickArrayUtil.getTickArrayStartIndex(TICK_UPPER, TICK_SPACING)).publicKey,
  };
}
export async function inspect(rpc: Connection) {
  checkNetwork(rpc.rpcEndpoint, await readRpc(() => rpc.getGenesisHash()), CLMM);
  const [program, info] = await readRpc(() => rpc.getMultipleAccountsInfo([CLMM, CONFIG]));
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  check(program?.executable && program.owner.equals(loader), "Missing executable CLMM program");
  const config = checkConfig(CONFIG, info);
  return { program: CLMM.toBase58(), config: CONFIG.toBase58(), index: config.index,
    tradeFeeRate: config.tradeFeeRate, tickSpacing: config.tickSpacing,
    protocolFeeRate: config.protocolFeeRate, fundFeeRate: config.fundFeeRate,
    wallet: WALLET.toBase58(), testSolLamports: await readRpc(() => rpc.getBalance(WALLET)),
    sqrtPriceX64: INITIAL_SQRT.toString(), tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
    priceLower: TickUtil.tickToPrice(TICK_LOWER, DECIMALS, DECIMALS).toFixed(12),
    priceUpper: TickUtil.tickToPrice(TICK_UPPER, DECIMALS, DECIMALS).toFixed(12),
    quote: Object.fromEntries(Object.entries(quotePosition()).map(([key, value]) => [key, value.toString()])) };
}
export async function verifyTokens(rpc: Connection, state: State, funded: boolean | "recorded" = true) {
  const a = addresses(state);
  const infos = await readRpc(() => rpc.getMultipleAccountsInfo([a.mintA, a.mintB, a.ataA, a.ataB]));
  const tokens = [a.mintA, a.mintB].map((mintAddress, index) => {
    const mint = unpackMint(mintAddress, infos[index], TOKEN_PROGRAM_ID);
    check(mint.isInitialized && mint.decimals === DECIMALS && mint.mintAuthority?.equals(WALLET)
      && mint.freezeAuthority === null, "Unexpected token decimals or mint/freeze authority");
    const issued = funded === "recorded" ? state.receipts[index === 0 ? "fundA" : "fundB"]?.status === "finalized" : funded;
    check(mint.supply === (issued ? SUPPLY : 0n), "Unexpected token supply; refusing a second mint");
    const ata = index === 0 ? a.ataA : a.ataB;
    const token = unpackAccount(ata, infos[index + 2], TOKEN_PROGRAM_ID);
    check(token.owner.equals(WALLET) && token.mint.equals(mintAddress) && !token.isFrozen
      && token.delegate === null, "Wrong ATA owner, mint or state");
    return { name: index === 0 ? "BEK Token A" : "BEK Token B", mint: mintAddress.toBase58(),
      ata: ata.toBase58(), decimals: mint.decimals, supply: mint.supply.toString(), amount: token.amount.toString(),
      mintAuthority: mint.mintAuthority!.toBase58(), freezeAuthority: null };
  });
  return tokens;
}
export async function verifyPool(rpc: Connection, state: State) {
  const a = addresses(state);
  const [poolInfo, vault0Info, vault1Info, observation, bitmap] = await readRpc(() => rpc.getMultipleAccountsInfo(
    [a.pool, a.vault0, a.vault1, a.observation, a.bitmap],
  ));
  const pool = PoolInfoLayout.decode(accountData(poolInfo, "PoolState", PoolInfoLayout.span));
  check(pool.configId.equals(CONFIG) && pool.creator.equals(WALLET), "Wrong pool config or creator");
  check(pool.mintA.equals(a.token0) && pool.mintB.equals(a.token1), "Wrong pool mints or token ordering");
  check(pool.vaultA.equals(a.vault0) && pool.vaultB.equals(a.vault1) && pool.observationId.equals(a.observation), "Wrong pool vaults or oracle");
  check(pool.mintDecimalsA === DECIMALS && pool.mintDecimalsB === DECIMALS && pool.tickSpacing === TICK_SPACING, "Wrong pool decimals or spacing");
  check(pool.sqrtPriceX64.eq(INITIAL_SQRT) && pool.tickCurrent === 0, "Pool price moved from the isolated 1:1 demo snapshot");
  check(pool.status === 0, "Pool operations are disabled");
  const v0 = unpackAccount(a.vault0, vault0Info), v1 = unpackAccount(a.vault1, vault1Info);
  check(v0.owner.equals(a.pool) && v1.owner.equals(a.pool) && v0.mint.equals(a.token0) && v1.mint.equals(a.token1)
    && !v0.isFrozen && !v1.isFrozen, "Wrong pool token vault mint/authority/state");
  const oracle = ObservationLayout.decode(accountData(observation, "ObservationState", ObservationLayout.span));
  check(oracle.poolId.equals(a.pool), "Wrong observation pool");
  const bits = TickArrayBitmapExtensionLayout.decode(accountData(bitmap, "TickArrayBitmapExtension", TickArrayBitmapExtensionLayout.span));
  check(bits.poolId.equals(a.pool), "Wrong bitmap pool");
  return { pool, vault0: v0.amount, vault1: v1.amount };
}
export async function verifyPosition(rpc: Connection, state: State) {
  const a = addresses(state), q = quotePosition();
  const tokens = await verifyTokens(rpc, state);
  const { pool, vault0, vault1 } = await verifyPool(rpc, state);
  const infos = await readRpc(() => rpc.getMultipleAccountsInfo(
    [a.position, a.nftMint, a.nftAta, a.tickArrayLower, a.tickArrayUpper, a.ata0, a.ata1],
  ));
  const position = PersonalPositionLayout.decode(accountData(infos[0], "PersonalPositionState", PersonalPositionLayout.span));
  check(position.poolId.equals(a.pool) && position.nftMint.equals(a.nftMint), "Position belongs to another pool or NFT");
  check(position.tickLower === TICK_LOWER && position.tickUpper === TICK_UPPER, "Wrong position ticks");
  check(position.liquidity.eq(q.liquidity) && position.liquidity.gtn(0) && pool.liquidity.eq(position.liquidity), "Unexpected or zero liquidity");
  const nft = unpackMint(a.nftMint, infos[1], TOKEN_2022_PROGRAM_ID);
  const nftAccount = unpackAccount(a.nftAta, infos[2], TOKEN_2022_PROGRAM_ID);
  check(nft.supply === 1n && nft.decimals === 0 && nft.mintAuthority === null, "Invalid Position NFT supply, decimals or mint authority");
  check(nftAccount.owner.equals(WALLET) && nftAccount.mint.equals(a.nftMint) && nftAccount.amount === 1n
    && !nftAccount.isFrozen && nftAccount.delegate === null, "Position NFT is not owned freely by the expected wallet");
  for (const [index, tick] of [[3, TICK_LOWER], [4, TICK_UPPER]]) {
    const array = TickArrayLayout.decode(accountData(infos[index], "TickArrayState", TickArrayLayout.span));
    check(array.poolId.equals(a.pool) && array.startTickIndex === TickArrayUtil.getTickArrayStartIndex(tick, TICK_SPACING), "Wrong tick array");
    const boundary = array.ticks.find((item) => item.tick === tick);
    check(boundary && boundary.liquidityGross.eq(position.liquidity), "Missing liquidity at position boundary");
  }
  const wallet0 = unpackAccount(a.ata0, infos[5]).amount, wallet1 = unpackAccount(a.ata1, infos[6]).amount;
  const before = state.positionBefore;
  check(before, "Missing pre-position balance snapshot");
  const amount0 = BigInt(before.wallet0) - wallet0, amount1 = BigInt(before.wallet1) - wallet1;
  check(amount0 > 0n && amount1 > 0n && amount0 <= BigInt(q.maxA.toString()) && amount1 <= BigInt(q.maxB.toString()), "Unexpected token debit or exceeded slippage");
  check(vault0 - BigInt(before.vault0) === amount0 && vault1 - BigInt(before.vault1) === amount1
    && wallet0 + vault0 === SUPPLY && wallet1 + vault1 === SUPPLY, "Token conservation failed");
  return { tokens, addresses: Object.fromEntries(Object.entries(a).map(([key, value]) => [key, value.toBase58()])),
    liquidity: position.liquidity.toString(), sqrtPriceX64: pool.sqrtPriceX64.toString(), tickCurrent: pool.tickCurrent,
    tickLower: position.tickLower, tickUpper: position.tickUpper,
    amounts: { token0: amount0.toString(), token1: amount1.toString(), wallet0: wallet0.toString(), wallet1: wallet1.toString(),
      vault0: vault0.toString(), vault1: vault1.toString() },
    nft: { program: TOKEN_2022_PROGRAM_ID.toBase58(), owner: WALLET.toBase58(), supply: "1", decimals: 0, mintAuthority: null } };
}
