import { PublicKey, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PoolInfoLayout, TickArrayLayout, TickArrayUtil, getPdaExBitmapAccount, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { CLMM, check } from "../raydium/config";
import { readRpc } from "../raydium/runtime";

export const VAULT_PROGRAM = new PublicKey("7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH");
export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export function vaultKeys(assetMint: PublicKey) {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, VAULT_PROGRAM)[0];
  const vault = pda([Buffer.from("vault"), assetMint.toBuffer()]);
  return { assetMint, vault, shareMint: pda([Buffer.from("share-mint"), vault.toBuffer()]),
    tokenVault: pda([Buffer.from("token-vault"), vault.toBuffer()]),
    strategy: pda([Buffer.from("strategy"), vault.toBuffer()]) };
}
export function userKeys(assetMint: PublicKey, user: PublicKey) {
  const { vault, shareMint, tokenVault } = vaultKeys(assetMint);
  return { user, assetMint, vault, shareMint, tokenVault,
    position: PublicKey.findProgramAddressSync([Buffer.from("position"), vault.toBuffer(), user.toBuffer()], VAULT_PROGRAM)[0],
    userAssetAccount: getAssociatedTokenAddressSync(assetMint, user), userShareAccount: getAssociatedTokenAddressSync(shareMint, user),
    tokenProgram: TOKEN_PROGRAM_ID };
}
export function strategyKeys(assetMint: PublicKey, quoteMint: PublicKey, administrator: PublicKey) {
  const keys = vaultKeys(assetMint);
  return { ...keys, administrator, quoteMint, quoteVault: getAssociatedTokenAddressSync(quoteMint, keys.vault, true),
    tokenProgram: TOKEN_PROGRAM_ID };
}
export function manageKeys(assetMint: PublicKey, quoteMint: PublicKey, administrator: PublicKey) {
  const { assetMint: _asset, ...keys } = strategyKeys(assetMint, quoteMint, administrator);
  return keys;
}
export async function swapKeys(rpc: Connection, assetMint: PublicKey, quoteMint: PublicKey, pool: PublicKey,
  administrator: PublicKey, aToB: boolean) {
  const info = await readRpc(() => rpc.getAccountInfo(pool));
  check(info?.owner.equals(CLMM), "Wrong CLMM pool owner");
  const data = PoolInfoLayout.decode(info!.data);
  const assetIs0 = data.mintA.equals(assetMint);
  check((assetIs0 && data.mintB.equals(quoteMint)) || (data.mintB.equals(assetMint) && data.mintA.equals(quoteMint)), "Incompatible Vault mint/pool pair");
  const zeroForOne = aToB ? assetIs0 : !assetIs0;
  const width = data.tickSpacing * 60;
  const start = TickArrayUtil.getTickArrayStartIndex(data.tickCurrent, data.tickSpacing);
  const candidates = [0, 1, 2].map((i) => getPdaTickArrayAddress(CLMM, pool, start + i * width * (zeroForOne ? -1 : 1)).publicKey);
  const infos = await readRpc(() => rpc.getMultipleAccountsInfo(candidates));
  check(infos[0]?.owner.equals(CLMM), "Current tick array is unavailable; this strategy requires active in-range liquidity");
  const ticks = candidates.filter((_key, i) => {
    if (!infos[i]) return false;
    check(infos[i]!.owner.equals(CLMM), "Wrong tick array owner");
    check(TickArrayLayout.decode(infos[i]!.data).poolId.equals(pool), "Wrong tick array pool");
    return true;
  }).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  const { shareMint: _share, ...base } = strategyKeys(assetMint, quoteMint, administrator);
  return { accounts: { ...base, pool, config: data.configId, raydiumProgram: CLMM,
    poolAssetVault: assetIs0 ? data.vaultA : data.vaultB, poolQuoteVault: assetIs0 ? data.vaultB : data.vaultA,
    observation: data.observationId, bitmap: getPdaExBitmapAccount(CLMM, pool).publicKey,
    tokenProgram2022: TOKEN_2022_PROGRAM_ID, memoProgram: MEMO }, ticks, zeroForOne,
    limit: zeroForOne ? data.sqrtPriceX64.muln(99).divn(100) : data.sqrtPriceX64.muln(101).divn(100), data };
}
export { ASSOCIATED_TOKEN_PROGRAM_ID };
