import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PoolInfoLayout, TickUtil, TickArrayUtil, LiquidityMathUtil, ClmmInstrument,
  getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { CLMM, check } from "../raydium/config";
import { readRpc } from "../raydium/runtime";
import { VAULT_PROGRAM, swapKeys, MEMO, ASSOCIATED_TOKEN_PROGRAM_ID } from "../strategy/client";

export const compute = ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 });
export const bn = (n: number | bigint | string) => new BN(n.toString());
export function chooseRange(tick: number, spacing: number) {
  check(Number.isInteger(tick) && Number.isInteger(spacing) && spacing > 0, "Invalid tick/spacing");
  const center = Math.floor(tick / spacing) * spacing;
  const lower = center - 10 * spacing, upper = center + 10 * spacing;
  check(lower >= -443636 && upper <= 443636 && lower <= tick && tick < upper, "Range outside CLMM limits");
  return { lower, upper };
}
export function limits(amount: BN, upper: boolean) {
  check(!amount.isNeg(), "Negative amount");
  return upper ? amount.muln(101).addn(99).divn(100) : amount.muln(99).divn(100);
}
export function liquidityQuote(sqrt: BN, lower: number, upper: number, budget0: BN, budget1: BN) {
  const lo = TickUtil.getSqrtPriceAtTick(lower), hi = TickUtil.getSqrtPriceAtTick(upper);
  check(sqrt.gt(lo) && sqrt.lt(hi), "Position must straddle the current price");
  check(budget0.gtn(0) && budget1.gtn(0), "Both budgets must be positive");
  const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(sqrt, lo, hi, budget0, budget1);
  check(liquidity.gtn(0), "Zero liquidity quote");
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(sqrt, lo, hi, liquidity, true);
  check(amountA.lte(budget0) && amountB.lte(budget1), "Quote exceeds budget");
  return { liquidity, amount0: amountA, amount1: amountB, max0: limits(amountA,true), max1: limits(amountB,true) };
}
export function withdrawalQuote(sqrt: BN, lower: number, upper: number, liquidity: BN) {
  const q = LiquidityMathUtil.getAmountsForLiquidity(sqrt,TickUtil.getSqrtPriceAtTick(lower),TickUtil.getSqrtPriceAtTick(upper),liquidity,false);
  return { amount0:q.amountA, amount1:q.amountB, min0:limits(q.amountA,false), min1:limits(q.amountB,false) };
}
export function spotQuoteToAsset(quoteUnits: bigint, sqrt: bigint, assetIs0: boolean) {
  check(quoteUnits >= 0n && sqrt > 0n, "Invalid spot conversion");
  const square = sqrt * sqrt, q128 = 1n << 128n;
  return assetIs0 ? quoteUnits * q128 / square : quoteUnits * square / q128;
}
export async function poolState(rpc: Connection, pool: PublicKey) {
  const info = await readRpc(() => rpc.getAccountInfo(pool));
  check(info?.owner.equals(CLMM), "Invalid pool owner");
  const data = PoolInfoLayout.decode(info!.data);
  check(data.rewardInfos.every((r) => r.mint.equals(PublicKey.default)), "Reward pools are unsupported");
  return data;
}
export async function positionKeys(rpc: Connection, asset: PublicKey, quote: PublicKey, pool: PublicKey,
  admin: PublicKey, nftMint: PublicKey, lower: number, upper: number) {
  const swap = await swapKeys(rpc,asset,quote,pool,admin,true);
  const { config: _config, observation: _observation, bitmap, memoProgram: _memo, ...core } = swap.accounts;
  const record = PublicKey.findProgramAddressSync([Buffer.from("liquidity"),core.strategy.toBuffer()],VAULT_PROGRAM)[0];
  const personalPosition = getPdaPersonalPositionAddress(CLMM,nftMint).publicKey;
  const nftAccount = getAssociatedTokenAddressSync(nftMint,core.vault,true,TOKEN_2022_PROGRAM_ID);
  const protocolPosition = getPdaProtocolPositionAddress(CLMM,pool,lower,upper).publicKey;
  const tickArrayLower = getPdaTickArrayAddress(CLMM,pool,TickArrayUtil.getTickArrayStartIndex(lower,swap.data.tickSpacing)).publicKey;
  const tickArrayUpper = getPdaTickArrayAddress(CLMM,pool,TickArrayUtil.getTickArrayStartIndex(upper,swap.data.tickSpacing)).publicKey;
  const common = { core,record,nftMint,nftAccount,personalPosition,protocolPosition,tickArrayLower,tickArrayUpper,bitmap };
  return { open: { ...common,systemProgram:SystemProgram.programId,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,rent:SYSVAR_RENT_PUBKEY },
    manage: { ...common,memoProgram:MEMO },
    close: { administrator:admin,vault:core.vault,strategy:core.strategy,record,nftMint,nftAccount,personalPosition,pool,
      raydiumProgram:CLMM,tokenProgram2022:TOKEN_2022_PROGRAM_ID,systemProgram:SystemProgram.programId },
    data:swap.data, assetIs0:swap.data.mintA.equals(asset) };
}
/** Explicit external trade: wallet ATAs and wallet signature, never Vault accounts. */
export async function externalSwap(rpc: Connection, asset: PublicKey, quote: PublicKey, pool: PublicKey,
  wallet: PublicKey, amount: BN, minimum: BN) {
  check(amount.gtn(0) && amount.lten(100_000) && minimum.gtn(0), "External demo swap capped at 100000 base units");
  const s = await swapKeys(rpc,asset,quote,pool,wallet,true);
  return ClmmInstrument.swapV2Instruction(CLMM,wallet,pool,s.accounts.config,
    getAssociatedTokenAddressSync(asset,wallet),getAssociatedTokenAddressSync(quote,wallet),
    s.accounts.poolAssetVault,s.accounts.poolQuoteVault,asset,quote,s.ticks.map((t)=>t.pubkey),s.accounts.observation,
    amount,minimum,s.limit,true,s.accounts.bitmap);
}
