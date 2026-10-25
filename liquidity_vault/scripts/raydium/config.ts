import { createHash } from "crypto";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import {
  ClmmConfigLayout, DEVNET_PROGRAM_ID, LiquidityMathUtil, MAX_SQRT_PRICE_X64,
  MIN_SQRT_PRICE_X64, TickUtil, getPdaAmmConfigId,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";

export const RPC = "https://api.devnet.solana.com";
export const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const CLMM = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
export const WALLET = new PublicKey("bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe");
export const CONFIG_INDEX = 0;
export const CONFIG = getPdaAmmConfigId(CLMM, CONFIG_INDEX).publicKey;
export const DECIMALS = 6;
export const SUPPLY = 100_000_000n; // 100 demo tokens per mint, issued exactly once.
export const TICK_SPACING = 60;
export const TRADE_FEE_RATE = 2500; // Denominator 1,000,000: 0.25%.
export const TICK_LOWER = -600;
export const TICK_UPPER = 600;
export const SLIPPAGE_BPS = 100;
export const INITIAL_SQRT = TickUtil.priceToSqrtPriceX64(new Decimal(1), DECIMALS, DECIMALS);

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function checkNetwork(endpoint: string, genesis: string, program: PublicKey) {
  check(endpoint === RPC && genesis === GENESIS, "Devnet endpoint/genesis required");
  check(program.equals(CLMM) && DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.equals(CLMM), "Wrong Raydium CLMM program");
}
export function orderedMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  check(!a.equals(b), "Token A and Token B must differ");
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
}
export function accountData(info: AccountInfo<Buffer> | null, name: string, span: number): Buffer {
  check(info && info.owner.equals(CLMM), `Wrong owner or missing ${name}`);
  check(info.data.length === span, `Wrong size for ${name}`);
  const discriminator = createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
  check(info.data.subarray(0, 8).equals(discriminator), `Wrong discriminator for ${name}`);
  return info.data;
}
export function checkConfig(address: PublicKey, info: AccountInfo<Buffer> | null) {
  check(address.equals(CONFIG), "Unexpected AMM config address");
  const config = ClmmConfigLayout.decode(accountData(info, "AmmConfig", ClmmConfigLayout.span));
  check(config.index === CONFIG_INDEX && config.tickSpacing === TICK_SPACING
    && config.tradeFeeRate === TRADE_FEE_RATE, "Unexpected fee tier or tick spacing");
  return config;
}
export function checkRange(lower: number, upper: number, spacing: number, sqrt: BN) {
  check(Number.isInteger(spacing) && spacing > 0, "Invalid tick spacing");
  check(Number.isInteger(lower) && Number.isInteger(upper) && lower >= -443636 && upper <= 443636
    && lower < upper && lower % spacing === 0 && upper % spacing === 0, "Invalid tick range");
  check(sqrt.gte(MIN_SQRT_PRICE_X64) && sqrt.lt(MAX_SQRT_PRICE_X64), "Invalid sqrtPriceX64");
  check(sqrt.gt(TickUtil.getSqrtPriceAtTick(lower)) && sqrt.lt(TickUtil.getSqrtPriceAtTick(upper)),
    "Initial price must be inside the position range");
}
export function quotePosition() {
  checkRange(TICK_LOWER, TICK_UPPER, TICK_SPACING, INITIAL_SQRT);
  const lower = TickUtil.getSqrtPriceAtTick(TICK_LOWER), upper = TickUtil.getSqrtPriceAtTick(TICK_UPPER);
  const { liquidity } = LiquidityMathUtil.getLiquidityAndAmountsFromAmount({
    sqrtPriceCurrentX64: INITIAL_SQRT, sqrtPriceLowerX64: lower, sqrtPriceUpperX64: upper,
    amountInfo: { type: "amountA", amount: new BN(10_000_000) },
  });
  // Recalculate from liquidity, not the helper's amount fields (SDK 0.2.74-alpha).
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(INITIAL_SQRT, lower, upper, liquidity, true);
  const maximum = (amount: BN) => amount.muln(10_000 + SLIPPAGE_BPS).addn(9_999).divn(10_000);
  check(liquidity.gtn(0) && amountA.gtn(0) && amountB.gtn(0), "Zero position liquidity or token amount");
  return { liquidity, amountA, amountB, maxA: maximum(amountA), maxB: maximum(amountB) };
}
