import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ApiV3Token, ClmmInstrument, getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { CLMM, CONFIG, INITIAL_SQRT, orderedMints, quotePosition } from "../../scripts/raydium/config";
import { vaultKeys, userKeys } from "../../scripts/strategy/client";
import { compute, bn } from "../../scripts/liquidity/client";
import { LiquidityVault } from "../../target/types/liquidity_vault";

export async function fixture(provider: anchor.AnchorProvider, program: anchor.Program<LiquidityVault>, user: Keypair, assetIs0 = true) {
  const payer = (provider.wallet as anchor.Wallet).payer;
  const first = await createMint(provider.connection,payer,payer.publicKey,payer.publicKey,6);
  const second = await createMint(provider.connection,payer,payer.publicKey,payer.publicKey,6);
  const [m0,m1] = orderedMints(first,second), [asset,quote] = assetIs0 ? [m0,m1] : [m1,m0];
  for (const mint of [asset,quote]) for (const owner of [payer.publicKey,user.publicKey]) {
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection,payer,mint,owner);
    await mintTo(provider.connection,payer,mint,ata.address,payer,100_000_000n);
  }
  const token = (address: string): ApiV3Token => ({ address,programId:TOKEN_PROGRAM_ID.toBase58(),decimals:6,
    chainId:101,name:"Local fixture",symbol:"TEST",logoURI:"",tags:[],extensions:{} });
  const built = ClmmInstrument.createPoolInstructions({ connection:provider.connection,programId:CLMM,owner:payer.publicKey,
    mintA:token(m0.toBase58()),mintB:token(m1.toBase58()),ammConfigId:CONFIG,initialPriceX64:INITIAL_SQRT });
  await provider.sendAndConfirm(new Transaction().add(compute,...built.instructions));
  const pool = built.address.poolId, nft = Keypair.generate(), q = quotePosition();
  const lo = TickArrayUtil.getTickArrayStartIndex(-600,60), hi = TickArrayUtil.getTickArrayStartIndex(600,60);
  await provider.sendAndConfirm(new Transaction().add(compute,ClmmInstrument.openPositionWithToken22NftInstruction(CLMM,payer.publicKey,pool,payer.publicKey,
    nft.publicKey,getAssociatedTokenAddressSync(nft.publicKey,payer.publicKey,false,TOKEN_2022_PROGRAM_ID),
    getPdaProtocolPositionAddress(CLMM,pool,-600,600).publicKey,getPdaTickArrayAddress(CLMM,pool,lo).publicKey,getPdaTickArrayAddress(CLMM,pool,hi).publicKey,
    getPdaPersonalPositionAddress(CLMM,nft.publicKey).publicKey,getAssociatedTokenAddressSync(m0,payer.publicKey),getAssociatedTokenAddressSync(m1,payer.publicKey),
    built.address.mintAVault,built.address.mintBVault,m0,m1,-600,600,lo,hi,q.liquidity,q.maxA,q.maxB,false,null)),[nft]);
  const { strategy:_strategy,...v } = vaultKeys(asset), u = userKeys(asset,user.publicKey);
  await program.methods.initializeVault().accountsStrict({ ...v,administrator:payer.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId }).rpc();
  await getOrCreateAssociatedTokenAccount(provider.connection,payer,v.shareMint,user.publicKey);
  await program.methods.openPosition().accountsStrict({ ...v,user:user.publicKey,position:u.position,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId }).signers([user]).rpc();
  await program.methods.deposit(bn(1_000_000),bn(1_000_000)).accountsStrict(u).signers([user]).rpc();
  return { asset,quote,pool,manualNft:nft.publicKey,manualPosition:getPdaPersonalPositionAddress(CLMM,nft.publicKey).publicKey };
}
