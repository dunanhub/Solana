import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount, unpackMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PersonalPositionLayout, TickArrayLayout, PositionUtils, TickArrayUtil, getPdaTickArrayAddress, getPdaPersonalPositionAddress } from "@raydium-io/raydium-sdk-v2";
import { CLMM, CONFIG, WALLET, check, checkConfig, checkNetwork } from "../raydium/config";
import { readRpc } from "../raydium/runtime";
import { VAULT_PROGRAM, vaultKeys, userKeys, strategyKeys } from "../strategy/client";
import { poolState, withdrawalQuote, spotQuoteToAsset } from "./client";
import { LiquidityVault } from "../../target/types/liquidity_vault";

export const A=new PublicKey("9fCGeyDFz86XXhUgT7c9zj4qYVBqrnc6B58Fcvv6zzhP"), B=new PublicKey("FGWg89P3tk45pxLHCy8u1A564jPaVHCJjJnk923iKhyG");
export const POOL=new PublicKey("CuATcxQ3yxU8MPtp7uiYkZdgYxyBZhNuPwf39XK81A2b");
const OLD=new PublicKey("97EfbGqcFVi2MsVtfcGcDYdxzfBaGUx5H6YzCMtbfe5S");
const MANUAL=new PublicKey("8Y3rCCZrTTSBaShqtNNPwJ8Xxw2EJcg46rCfG8LgDkj7"), MANUAL_NFT=new PublicKey("AKbjsHiFyGFLsWB2KRA9Lccbc8Wbzn7oVkT9yDoPajci");
const LOADER=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const v=vaultKeys(A),u=userKeys(A,WALLET),s=strategyKeys(A,B,WALLET);
export const recordAddress=PublicKey.findProgramAddressSync([Buffer.from("liquidity"),v.strategy.toBuffer()],VAULT_PROGRAM)[0];
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
export async function protectedAccounts(rpc:Connection) {
  const old=vaultKeys(OLD),user=userKeys(OLD,WALLET);
  const keys=[old.vault,old.tokenVault,old.shareMint,user.position,user.userAssetAccount,user.userShareAccount,
    MANUAL,getAssociatedTokenAddressSync(MANUAL_NFT,WALLET,false,TOKEN_2022_PROGRAM_ID),A,B];
  const infos=await readRpc(()=>rpc.getMultipleAccountsInfo(keys));
  return Object.fromEntries(keys.map((key,i)=>{check(infos[i],`Missing protected account ${key}`);return [key.toBase58(),hash(Buffer.concat([infos[i]!.owner.toBuffer(),infos[i]!.data]))];}));
}
export async function deployment(rpc:Connection) {
  checkNetwork(rpc.rpcEndpoint,await readRpc(()=>rpc.getGenesisHash()),CLMM);
  const clmm=await readRpc(()=>rpc.getAccountInfo(CLMM));
  check(clmm?.executable&&clmm.owner.equals(LOADER)&&clmm.data.readUInt32LE(0)===2,"Wrong CLMM executable");
  const clmmDataAddress=new PublicKey(clmm.data.subarray(4,36));
  const clmmData=await readRpc(()=>rpc.getAccountInfo(clmmDataAddress));
  check(clmmData!==null&&clmmData.owner.equals(LOADER)&&clmmData.data.readUInt32LE(0)===3,"Wrong CLMM ProgramData");
  const fixture=fs.readFileSync(path.resolve(__dirname,"../../target/fixtures/raydium-clmm.so"));
  check(clmmData.data.subarray(45).equals(fixture),"CLMM changed since local integration tests; refresh fixture and retest");
  const executable=await readRpc(()=>rpc.getAccountInfo(VAULT_PROGRAM));
  check(executable!==null&&executable.executable&&executable.owner.equals(LOADER)&&executable.data.readUInt32LE(0)===2,"Wrong Vault executable");
  const dataAddress=new PublicKey(executable.data.subarray(4,36));
  const [data,config,ma,mb,nft,manual]=await readRpc(()=>rpc.getMultipleAccountsInfo([dataAddress,CONFIG,A,B,
    getAssociatedTokenAddressSync(MANUAL_NFT,WALLET,false,TOKEN_2022_PROGRAM_ID),MANUAL]));
  check(data!==null&&data.owner.equals(LOADER)&&data.data.readUInt32LE(0)===3&&data.data[12]===1
    &&new PublicKey(data.data.subarray(13,45)).equals(WALLET),"Wrong upgrade authority");
  checkConfig(CONFIG,config);
  for(const [key,info] of [[A,ma],[B,mb]] as const) {const m=unpackMint(key,info);check(m.decimals===6&&m.supply===100_000_000n&&m.mintAuthority?.equals(WALLET)&&m.freezeAuthority===null,"Wrong asset mint configuration");}
  check(nft&&manual?.owner.equals(CLMM),"Missing Week 11 NFT/position");
  const n=unpackAccount(getAssociatedTokenAddressSync(MANUAL_NFT,WALLET,false,TOKEN_2022_PROGRAM_ID),nft,TOKEN_2022_PROGRAM_ID);
  check(n.owner.equals(WALLET)&&n.amount===1n&&PersonalPositionLayout.decode(manual!.data).liquidity.toString()==="338374998","Week 11 position changed");
  const pool=await poolState(rpc,POOL);
  check(pool.creator.equals(WALLET)&&pool.configId.equals(CONFIG)&&pool.mintA.equals(A)&&pool.mintB.equals(B),"Wrong pool bindings");
  const binary=fs.readFileSync(path.resolve(__dirname,"../../target/deploy/liquidity_vault.so"));
  const deployed=data.data.subarray(45);
  const matches=deployed.length>=binary.length&&deployed.subarray(0,binary.length).equals(binary)&&deployed.subarray(binary.length).every(b=>b===0);
  const balance=await readRpc(()=>rpc.getBalance(WALLET));
  const bufferRent=await readRpc(()=>rpc.getMinimumBalanceForRentExemption(binary.length+37));
  const rent=await readRpc(()=>rpc.getMinimumBalanceForRentExemption(Math.max(binary.length+45,data.data.length)));
  return {cluster:"devnet",program:VAULT_PROGRAM.toBase58(),programData:dataAddress.toBase58(),authority:WALLET.toBase58(),
    binaryBytes:binary.length,binaryHash:hash(binary),binaryMatches:matches,slot:data.data.readBigUInt64LE(4).toString(),
    balanceLamports:balance,upgradePeakLamports:bufferRent+Math.max(0,rent-data.lamports)+100_000_000,
    raydium:{program:CLMM.toBase58(),programData:clmmDataAddress.toBase58(),slot:clmmData.data.readBigUInt64LE(4).toString(),sha256:hash(fixture),bytes:fixture.length}};
}
export async function verifyUpgrade(rpc:Connection,signature:string) {
  const d=await deployment(rpc); check(d.binaryMatches,"Binary mismatch");
  const tx=await readRpc(()=>rpc.getParsedTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0}));
  check(tx?.meta&&tx.meta.err===null&&tx.slot.toString()===d.slot,"Not the current finalized upgrade");
  const ix=tx.transaction.message.instructions.find(i=>i.programId.equals(LOADER)&&"parsed" in i&&i.parsed.type==="upgrade");
  check(ix&&"parsed" in ix&&ix.parsed.info.programAccount===d.program&&ix.parsed.info.authority===d.authority,"Wrong loader instruction");
  const buffer=new PublicKey(ix.parsed.info.bufferAccount);
  check(await readRpc(()=>rpc.getAccountInfo(buffer))===null,"Buffer not closed");
  const proof={...d,signature,finalized:true,bufferClosed:true,buffer:buffer.toBase58(),explorer:link(signature),verifiedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,"upgrade-proof.json"),JSON.stringify(proof,null,2)+"\n"); return proof;
}
export const link=(signature:string)=>`https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export async function snapshot(rpc:Connection,program:anchor.Program<LiquidityVault>,nftMint?:PublicKey) {
  if(!nftMint){
    const info=await readRpc(()=>rpc.getAccountInfo(recordAddress));
    if(info){check(info.owner.equals(VAULT_PROGRAM),"Wrong liquidity record owner");nftMint=program.coder.accounts.decode("liquidityPosition",info.data).nftMint;}
  }
  const pool=await poolState(rpc,POOL);
  const keys=[v.vault,v.strategy,v.tokenVault,s.quoteVault,v.shareMint,u.userAssetAccount,getAssociatedTokenAddressSync(B,WALLET),
    u.userShareAccount,u.position,recordAddress,pool.vaultA,pool.vaultB];
  if(nftMint) keys.push(nftMint,getAssociatedTokenAddressSync(nftMint,v.vault,true,TOKEN_2022_PROGRAM_ID),getPdaPersonalPositionAddress(CLMM,nftMint).publicKey);
  const infos=await readRpc(()=>rpc.getMultipleAccountsInfo(keys));
  check(infos[0]&&infos[1],"Week 12 Vault/Strategy missing");
  const vault=program.coder.accounts.decode("vaultConfig",infos[0]!.data),strategy=program.coder.accounts.decode("strategy",infos[1]!.data);
  check(vault.administrator.equals(WALLET)&&strategy.vault.equals(v.vault)&&strategy.pool.equals(POOL)&&strategy.quoteMint.equals(B),"Wrong Vault/strategy bindings");
  const amount=(i:number)=>unpackAccount(keys[i],infos[i]).amount.toString();
  const a=amount(2),b=amount(3),supply=unpackMint(v.shareMint,infos[4]).supply.toString();
  const r=infos[9]?program.coder.accounts.decode("liquidityPosition",infos[9]!.data):null;
  const personal=infos[14]?PersonalPositionLayout.decode(infos[14]!.data):null;
  let principalA="0",principalB="0",estimatedFeeA="0",estimatedFeeB="0";
  if(personal) {
    check(personal.poolId.equals(POOL)&&personal.nftMint.equals(nftMint!),"Wrong personal position");
    const q=withdrawalQuote(pool.sqrtPriceX64,personal.tickLower,personal.tickUpper,personal.liquidity);
    principalA=q.amount0.toString();principalB=q.amount1.toString();
    if(personal.liquidity.gtn(0)) {
      const starts=[personal.tickLower,personal.tickUpper].map(t=>getPdaTickArrayAddress(CLMM,POOL,TickArrayUtil.getTickArrayStartIndex(t,pool.tickSpacing)).publicKey);
      const arr=await readRpc(()=>rpc.getMultipleAccountsInfo(starts));
      const lo=TickArrayLayout.decode(arr[0]!.data).ticks.find(t=>t.tick===personal.tickLower)!;
      const hi=TickArrayLayout.decode(arr[1]!.data).ticks.find(t=>t.tick===personal.tickUpper)!;
      const fees=PositionUtils.GetPositionFees(pool,personal,lo,hi);estimatedFeeA=fees.tokenFeeAmountA.toString();estimatedFeeB=fees.tokenFeeAmountB.toString();
    } else {estimatedFeeA=personal.tokenFeesOwedA.toString();estimatedFeeB=personal.tokenFeesOwedB.toString();}
  }
  const nft=infos[13]?unpackAccount(keys[13],infos[13],TOKEN_2022_PROGRAM_ID):null;
  const mint=infos[12]?unpackMint(keys[12],infos[12],TOKEN_2022_PROGRAM_ID):null;
  const totalA=BigInt(a)+BigInt(principalA)+BigInt(estimatedFeeA), totalB=BigInt(b)+BigInt(principalB)+BigInt(estimatedFeeB);
  const nav=totalA+spotQuoteToAsset(totalB,BigInt(pool.sqrtPriceX64.toString()),true);
  const capital=BigInt(principalA)+spotQuoteToAsset(BigInt(principalB),BigInt(pool.sqrtPriceX64.toString()),true);
  const basis=r?BigInt(r.depositedA.toString())+spotQuoteToAsset(BigInt(r.depositedB.toString()),BigInt(pool.sqrtPriceX64.toString()),true):0n;
  const returned=r?BigInt(r.withdrawnA.toString())+spotQuoteToAsset(BigInt(r.withdrawnB.toString()),BigInt(pool.sqrtPriceX64.toString()),true):0n;
  return {a,b,supply,userA:amount(5),userB:amount(6),userShares:amount(7),history:program.coder.accounts.decode("userPosition",infos[8]!.data).shares.toString(),
    version:vault.version,active:strategy.active,recordedB:strategy.recordedQuoteBalance.toString(),swapCount:strategy.swapCount.toString(),
    vaultLamports:infos[0]!.lamports,poolA:amount(10),poolB:amount(11),tick:pool.tickCurrent,sqrtPriceX64:pool.sqrtPriceX64.toString(),poolLiquidity:pool.liquidity.toString(),
    feeGrowthGlobalA:pool.feeGrowthGlobalX64A.toString(),feeGrowthGlobalB:pool.feeGrowthGlobalX64B.toString(),
    nft:nft?{owner:nft.owner.toBase58(),mint:nft.mint.toBase58(),amount:nft.amount.toString(),supply:mint?.supply.toString(),decimals:mint?.decimals}:null,
    mintExists:!!infos[12],personalExists:!!personal,
    position:personal?{address:keys[14].toBase58(),liquidity:personal.liquidity.toString(),lower:personal.tickLower,upper:personal.tickUpper,
      owedA:personal.tokenFeesOwedA.toString(),owedB:personal.tokenFeesOwedB.toString(),checkpointA:personal.feeGrowthInsideLastX64A.toString(),
      checkpointB:personal.feeGrowthInsideLastX64B.toString(),rewardOwed:personal.rewardInfos.map(r=>r.rewardAmountOwed.toString())}:null,
    record:r?{open:r.open,position:r.position.toBase58(),nftMint:r.nftMint.toBase58(),liquidity:r.liquidity.toString(),lower:r.tickLower,upper:r.tickUpper,
      depositedA:r.depositedA.toString(),depositedB:r.depositedB.toString(),withdrawnA:r.withdrawnA.toString(),withdrawnB:r.withdrawnB.toString(),
      feesA:r.feesA.toString(),feesB:r.feesB.toString(),cycle:r.cycle.toString(),rentReturned:r.rentReturned.toString()}:null,
    analysis:{principalA,principalB,estimatedFeeA,estimatedFeeB,spotNavABaseUnits:nav.toString(),principalPnlVsHoldAtCurrentSpot:(capital+returned-basis).toString(),
      priceSource:"CLMM sqrtPriceX64 squared / 2^128; raw B per raw A; both mints have 6 decimals",rounding:"floor per conversion and withdrawal quote",
      warning:"Analytical spot mark only; manipulable, no oracle/TWAP and not a production NAV or share quote; collected fees already included in cash"}};
}
export type Snapshot=Awaited<ReturnType<typeof snapshot>>;
function publicValue(value: unknown): unknown {
  if(anchor.BN.isBN(value))return value.toString(10);
  if(value instanceof PublicKey)return value.toBase58();
  if(Array.isArray(value))return value.map(publicValue);
  if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicValue(v)]));
  return value;
}
export async function inspectTransaction(rpc:Connection,program:anchor.Program<LiquidityVault>,signature:string,expected:string[],external=false) {
  const tx=await readRpc(()=>rpc.getParsedTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0}));
  check(tx?.meta&&tx.meta.err===null,"Missing finalized successful transaction");
  const invocations: {name:string;authority:string;stackHeight:number|undefined}[]=[];
  const discriminator=(name:string)=>createHash("sha256").update(`global:${name}`).digest().subarray(0,8);
  const inspect=(ix:typeof tx.transaction.message.instructions[number],parent?:PublicKey)=>{
    if(!ix.programId.equals(CLMM))return;
    check("data" in ix&&"accounts" in ix,"Missing raw CLMM instruction");
    const bytes=anchor.utils.bytes.bs58.decode(ix.data),name=expected.find(n=>bytes.subarray(0,8).equals(discriminator(n)));
    check(name,"Unexpected CLMM instruction");
    const authority=ix.accounts[0];
    const height=(ix as unknown as {stackHeight?:number}).stackHeight;
    if(external) check(parent===undefined&&authority.equals(WALLET),"External trade must be a direct wallet swap");
    else {check(parent?.equals(VAULT_PROGRAM)&&height===2,"Expected Vault -> Raydium CPI");
      check(name==="open_position_with_token22_nft"?ix.accounts[1].equals(v.vault):authority.equals(v.vault),"Wrong Vault NFT owner/CPI authority");
      const pair=name==="increase_liquidity_v2"?[7,8]:name==="decrease_liquidity_v2"?[9,10]:null;
      if(pair)check(ix.accounts[pair[0]].equals(v.tokenVault)&&ix.accounts[pair[1]].equals(s.quoteVault),"CPI tokens must flow through Vault accounts");
    }
    invocations.push({name,authority:authority.toBase58(),stackHeight:height});
  };
  if(external) tx.transaction.message.instructions.forEach(ix=>inspect(ix));
  else for(const g of tx.meta.innerInstructions??[]) for(const ix of g.instructions) inspect(ix,tx.transaction.message.instructions[g.index].programId);
  for(const name of expected)check(invocations.some(i=>i.name===name),`Missing ${name}`);
  const events=[...new anchor.EventParser(VAULT_PROGRAM,program.coder).parseLogs(tx.meta.logMessages??[])].map(e=>({name:e.name,data:publicValue(e.data)}));
  return {signature,slot:tx.slot,explorer:link(signature),invocations,events};
}
