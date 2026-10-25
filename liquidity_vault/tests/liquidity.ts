import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAccount,getMint,getOrCreateAssociatedTokenAccount,getAssociatedTokenAddressSync,transferChecked,freezeAccount,thawAccount,TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PersonalPositionLayout, PositionUtils, TickArrayLayout } from "@raydium-io/raydium-sdk-v2";
import { LiquidityVault } from "../target/types/liquidity_vault";
import { fixture } from "./fixtures/liquidity";
import { CLMM } from "../scripts/raydium/config";
import { vaultKeys,userKeys,strategyKeys,manageKeys,swapKeys,ASSOCIATED_TOKEN_PROGRAM_ID } from "../scripts/strategy/client";
import { positionKeys,chooseRange,liquidityQuote,withdrawalQuote,poolState,externalSwap,compute,bn } from "../scripts/liquidity/client";

describe("Week 13 — Vault-owned real CLMM liquidity", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(env.connection.rpcEndpoint,"confirmed"),env.wallet,{commitment:"confirmed",preflightCommitment:"confirmed"});
  if (!["127.0.0.1","localhost","[::1]"].includes(new URL(provider.connection.rpcEndpoint).hostname)) throw new Error("Local validator only");
  const program = new anchor.Program<LiquidityVault>(JSON.parse(readFileSync(join(__dirname,"../target/idl/liquidity_vault.json"),"utf8")),provider);
  const payer = (provider.wallet as anchor.Wallet).payer, user = Keypair.generate(), outsider = Keypair.generate(), nft = Keypair.generate();
  let f: Awaited<ReturnType<typeof fixture>>, other: typeof f, k: Awaited<ReturnType<typeof positionKeys>>;
  let ticks: {lower:number;upper:number}, added: anchor.BN, initialShares: bigint;
  async function record() { return program.account.liquidityPosition.fetch(k.open.record); }
  async function personal() { return PersonalPositionLayout.decode((await provider.connection.getAccountInfo(k.open.personalPosition))!.data); }
  async function balances() { return { a:(await getAccount(provider.connection,k.open.core.tokenVault)).amount,
    b:(await getAccount(provider.connection,k.open.core.quoteVault)).amount,
    shares:(await getMint(provider.connection,vaultKeys(f.asset).shareMint)).supply }; }
  function keys(value: unknown): PublicKey[] {
    if (value instanceof PublicKey) return [value];
    return typeof value === "object" && value !== null ? Object.values(value).flatMap(keys) : [];
  }
  async function snapshot() {
    const all = [...keys(k.open),...keys(userKeys(f.asset,user.publicKey)),f.manualPosition];
    const unique = [...new Map(all.filter((p)=>!p.equals(payer.publicKey)&&!p.equals(user.publicKey)).map((p)=>[p.toBase58(),p])).values()];
    return (await provider.connection.getMultipleAccountsInfo(unique)).map((i)=>i && ({owner:i.owner.toBase58(),data:i.data.toString("base64"),lamports:i.lamports}));
  }
  async function rejects(action:()=>Promise<unknown>,pattern:RegExp) {
    const before = await snapshot(); let error: unknown;
    try {await action();} catch(e) {error=e;}
    expect(error,"unexpected success").not.to.equal(undefined);
    const e = error as {logs?:string[]}; const message=[String(error),...(e.logs??[])].join("\n");
    expect(message).to.match(pattern); expect(await snapshot()).to.deep.equal(before); return message;
  }
  const manage = (overrides={}, coreOverrides={}) => ({...k.manage,...overrides,core:{...k.manage.core,...coreOverrides}});
  const inc = (amount:anchor.BN,maxA=bn(1000),maxB=bn(1000),overrides={},coreOverrides={}) => program.methods.increaseLiquidity(amount,maxA,maxB).accountsStrict(manage(overrides,coreOverrides)).preInstructions([compute]);
  const collect = (minA=bn(0),minB=bn(0),overrides={},coreOverrides={}) => program.methods.collectFees(minA,minB).accountsStrict(manage(overrides,coreOverrides)).preInstructions([compute]);
  const dec = (amount:anchor.BN,minA=bn(1),minB=bn(1)) => program.methods.decreaseLiquidity(amount,minA,minB).accountsStrict(k.manage).preInstructions([compute]);
  const close = (overrides={}) => program.methods.closeLiquidityPosition().accountsStrict({...k.close,...overrides}).preInstructions([compute]);
  const end = () => program.methods.endStrategy().accountsStrict(manageKeys(f.asset,f.quote,payer.publicKey));
  async function swap(aToB:boolean,amount:bigint,min=1n) {
    const s=await swapKeys(provider.connection,f.asset,f.quote,f.pool,payer.publicKey,aToB);
    return program.methods.swap(aToB,bn(amount),bn(min),s.limit).accountsStrict(s.accounts).remainingAccounts(s.ticks).preInstructions([compute]).rpc();
  }
  before(async()=>{
    await provider.sendAndConfirm(new Transaction().add(...[user,outsider].map((key)=>SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:key.publicKey,lamports:100_000_000}))));
    f=await fixture(provider,program,user); other=await fixture(provider,program,user,false);
    await program.methods.initializeStrategy().accountsStrict({...strategyKeys(f.asset,f.quote,payer.publicKey),pool:f.pool,raydiumProgram:CLMM,
      associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).rpc();
    const p=await poolState(provider.connection,f.pool); ticks=chooseRange(p.tickCurrent,p.tickSpacing);
    k=await positionKeys(provider.connection,f.asset,f.quote,f.pool,payer.publicKey,nft.publicKey,ticks.lower,ticks.upper);
    initialShares=(await balances()).shares;
  });
  it("rejects unauthorized open",async()=>{
    await rejects(()=>program.methods.openLiquidityPosition(ticks.lower,ticks.upper).accountsStrict({...k.open,core:{...k.open.core,administrator:outsider.publicKey}}).signers([nft,outsider]).rpc(),/ConstraintHasOne/);
  });
  it("rejects an administrator-owned NFT recipient",async()=>{
    const adminAta=getAssociatedTokenAddressSync(nft.publicKey,payer.publicKey,false,TOKEN_2022_PROGRAM_ID);
    await rejects(()=>program.methods.openLiquidityPosition(ticks.lower,ticks.upper).accountsStrict({...k.open,nftAccount:adminAta}).signers([nft]).rpc(),/InvalidLiquidityPosition/);
  });
  it("rejects unaligned ticks",async()=>{
    await rejects(()=>program.methods.openLiquidityPosition(ticks.lower+1,ticks.upper).accountsStrict(k.open).signers([nft]).rpc(),/InvalidPositionRange/);
  });
  it("opens a distinct position through CPI with NFT held by Vault PDA",async()=>{
    const before=await balances();
    const sig=await program.methods.openLiquidityPosition(ticks.lower,ticks.upper).accountsStrict(k.open).preInstructions([compute]).signers([nft]).rpc();
    const n=await getAccount(provider.connection,k.open.nftAccount,"confirmed",TOKEN_2022_PROGRAM_ID);
    const m=await getMint(provider.connection,nft.publicKey,"confirmed",TOKEN_2022_PROGRAM_ID);
    expect(n.owner.equals(k.open.core.vault)).to.equal(true); expect(n.amount).to.equal(1n); expect(m.supply).to.equal(1n);
    expect(n.mint.equals(f.manualNft)).to.equal(false); expect((await personal()).poolId.equals(f.pool)).to.equal(true);
    expect((await personal()).tickLower).to.equal(ticks.lower); expect((await personal()).tickUpper).to.equal(ticks.upper);
    expect((await record()).open).to.equal(true); expect((await record()).liquidity.toString()).to.equal("0");
    expect((await program.account.vaultConfig.fetch(k.open.core.vault)).version).to.equal(0xc1);
    expect(await balances()).to.deep.equal(before);
    const tx=await provider.connection.getTransaction(sig,{commitment:"confirmed",maxSupportedTransactionVersion:0});
    expect(tx!.meta!.logMessages!.join("\n")).to.include(`Program ${CLMM} invoke [2]`);
  });
  it("old end cannot unlock an empty open position even with zero B",async()=>{
    expect((await balances()).b).to.equal(0n); await rejects(()=>end().rpc(),/PositionStillOpen/);
  });
  it("rejects a second position while the first is open",async()=>{
    const another=Keypair.generate(), next=await positionKeys(provider.connection,f.asset,f.quote,f.pool,payer.publicKey,another.publicKey,ticks.lower,ticks.upper);
    await rejects(()=>program.methods.openLiquidityPosition(ticks.lower,ticks.upper).accountsStrict(next.open).signers([another]).rpc(),/PositionStillOpen/);
  });
  it("keeps deposit and withdraw blocked with the CLMM position flag",async()=>{
    for (const method of [program.methods.deposit(bn(1),bn(1)),program.methods.withdraw(bn(1),bn(1))])
      await rejects(()=>method.accountsStrict(userKeys(f.asset,user.publicKey)).signers([user]).rpc(),/StrategyActive/);
  });
  it("prepares quote assets using the preserved Week 12 swap",async()=>{
    await swap(true,450000n,400000n); expect((await balances()).b>400000n).to.equal(true);
  });
  it("requires admin for increase, collect, decrease and close",async()=>{
    await rejects(()=>inc(bn(1000),bn(100),bn(100),{},{administrator:outsider.publicKey}).signers([outsider]).rpc(),/ConstraintHasOne/);
    await rejects(()=>collect(bn(0),bn(0),{},{administrator:outsider.publicKey}).signers([outsider]).rpc(),/ConstraintHasOne/);
    await rejects(()=>program.methods.decreaseLiquidity(bn(1),bn(1),bn(1)).accountsStrict(manage({},{administrator:outsider.publicKey})).signers([outsider]).rpc(),/ConstraintHasOne/);
    await rejects(()=>close({administrator:outsider.publicKey}).signers([outsider]).rpc(),/ConstraintHasOne/);
  });
  for (const field of ["record","nftMint","nftAccount","personalPosition","protocolPosition","tickArrayLower","tickArrayUpper","bitmap","memoProgram"] as const) {
    it(`rejects substituted ${field}`,async()=>{
      const bad=await positionKeys(provider.connection,other.asset,other.quote,other.pool,payer.publicKey,other.manualNft,ticks.lower,ticks.upper);
      await rejects(()=>collect(bn(0),bn(0),{[field]:field==="memoProgram"?SystemProgram.programId:bad.manage[field]}).rpc(),/Constraint|AccountNotInitialized|InvalidLiquidityPosition|InvalidRaydiumAccount|InvalidTickArray/);
    });
  }
  for (const field of ["vault","strategy","assetMint","quoteMint","tokenVault","quoteVault","pool","poolAssetVault","poolQuoteVault","raydiumProgram","tokenProgram","tokenProgram2022"] as const) {
    it(`rejects substituted core ${field}`,async()=>{
      const bad=await positionKeys(provider.connection,other.asset,other.quote,other.pool,payer.publicKey,other.manualNft,ticks.lower,ticks.upper);
      await rejects(()=>collect(bn(0),bn(0),{},{[field]:field.endsWith("Program")||field==="tokenProgram2022"?SystemProgram.programId:bad.manage.core[field]}).rpc(),/Constraint|AccountNotInitialized|InvalidProgram|InvalidLiquidityPosition|InvalidRaydiumAccount/);
    });
  }
  it("rejects insufficient funding and zero liquidity",async()=>{
    await rejects(()=>inc(bn(1000),bn("18446744073709551615"),bn(1)).rpc(),/InsufficientFunds/);
    await rejects(()=>inc(bn(0)).rpc(),/InvalidLiquidityAmount/);
  });
  it("rolls back an impossible increase slippage",async()=>{
    await rejects(()=>inc(bn(10_000_000),bn(1),bn(1)).rpc(),/PriceSlippageCheck/);
  });
  it("adds real Vault liquidity and records both token debits",async()=>{
    const p=await poolState(provider.connection,f.pool), q=liquidityQuote(p.sqrtPriceX64,ticks.lower,ticks.upper,bn(350000),bn(350000));
    const before=await balances(); await inc(q.liquidity,q.max0,q.max1).rpc(); added=q.liquidity;
    const after=await balances(), r=await record();
    expect(r.liquidity.eq(added)).to.equal(true); expect((await personal()).liquidity.eq(added)).to.equal(true);
    expect(r.depositedA.toString()).to.equal((before.a-after.a).toString()); expect(r.depositedB.toString()).to.equal((before.b-after.b).toString());
    expect(before.a>after.a&&before.b>after.b).to.equal(true); expect(after.shares).to.equal(initialShares);
  });
  it("cannot close a position with nonzero liquidity",async()=>{await rejects(()=>close().rpc(),/UnsettledPosition/);});
  it("cannot transfer the Vault NFT to the administrator",async()=>{
    const dest=await getOrCreateAssociatedTokenAccount(provider.connection,payer,nft.publicKey,payer.publicKey,false,"confirmed",undefined,TOKEN_2022_PROGRAM_ID);
    await rejects(()=>transferChecked(provider.connection,payer,k.open.nftAccount,nft.publicKey,dest.address,payer,1n,0,[],undefined,TOKEN_2022_PROGRAM_ID),/owner|0x4|frozen|0x11/i);
  });
  it("executes one external wallet swap and observes nonzero accrued fees",async()=>{
    const before=await balances();
    await provider.sendAndConfirm(new Transaction().add(compute,await externalSwap(provider.connection,f.asset,f.quote,f.pool,user.publicKey,bn(100000),bn(95000))),[user]);
    expect(await balances()).to.deep.equal(before);
    const p=await poolState(provider.connection,f.pool), pos=await personal();
    const infos=await provider.connection.getMultipleAccountsInfo([k.manage.tickArrayLower,k.manage.tickArrayUpper]);
    const lo=TickArrayLayout.decode(infos[0]!.data).ticks.find((t)=>t.tick===ticks.lower)!;
    const hi=TickArrayLayout.decode(infos[1]!.data).ticks.find((t)=>t.tick===ticks.upper)!;
    const fees=PositionUtils.GetPositionFees(p,pos,lo,hi);
    expect(fees.tokenFeeAmountA.gtn(0)).to.equal(true); expect(p.tickCurrent>=ticks.lower&&p.tickCurrent<ticks.upper).to.equal(true);
  });
  it("rolls back collection with an impossible minimum",async()=>{await rejects(()=>collect(bn(1000000),bn(0)).rpc(),/SlippageExceeded/);});
  it("collects positive fees into the Vault with unchanged liquidity",async()=>{
    const before=await balances(); await collect(bn(1),bn(0)).rpc(); const after=await balances(), r=await record();
    expect(after.a>before.a).to.equal(true); expect(r.feesA.toString()).to.equal((after.a-before.a).toString());
    expect(r.liquidity.eq(added)).to.equal(true); expect((await personal()).tokenFeesOwedA.toString()).to.equal("0");
  });
  it("does not count repeated zero-fee collection as income",async()=>{
    const before=await record(); await collect().rpc(); const after=await record(); expect(after.feesA.eq(before.feesA)).to.equal(true);
  });
  it("rolls back all CPI changes in an actual failed local decrease transaction",async()=>{
    const before=await snapshot(), latest=await provider.connection.getLatestBlockhash("confirmed");
    const ix=await dec(added.divn(2),bn(100000000),bn(100000000)).instruction();
    const tx=new Transaction({feePayer:payer.publicKey,...latest}).add(compute,ix); tx.sign(payer);
    const sig=await provider.connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:0});
    expect((await provider.connection.confirmTransaction({signature:sig,...latest},"confirmed")).value.err).not.to.equal(null);
    const result=await provider.connection.getTransaction(sig,{commitment:"confirmed",maxSupportedTransactionVersion:0});
    expect(result!.meta!.logMessages!.join("\n")).to.include("PriceSlippageCheck");
    expect(result!.meta!.logMessages!.join("\n")).to.include(`Program ${CLMM} success`);
    expect(await snapshot()).to.deep.equal(before);
  });
  it("partially removes liquidity into Vault accounts",async()=>{
    const amount=added.divn(2), p=await poolState(provider.connection,f.pool), q=withdrawalQuote(p.sqrtPriceX64,ticks.lower,ticks.upper,amount);
    const before=await balances(); await dec(amount,q.min0,q.min1).rpc(); const after=await balances();
    expect((await record()).liquidity.eq(added.sub(amount))).to.equal(true); expect(after.a>before.a&&after.b>before.b).to.equal(true);
  });
  it("fully removes the remaining liquidity and settles all fees",async()=>{
    const r=await record(), p=await poolState(provider.connection,f.pool), q=withdrawalQuote(p.sqrtPriceX64,ticks.lower,ticks.upper,r.liquidity);
    await dec(r.liquidity,q.min0,q.min1).rpc(); expect((await personal()).liquidity.toString()).to.equal("0");
    expect((await record()).withdrawnA.gtn(0)).to.equal(true); await rejects(()=>end().rpc(),/PositionStillOpen/);
  });
  it("closes the NFT, its ATA and personal position and records real closure",async()=>{
    await close().rpc(); expect((await record()).open).to.equal(false); expect((await record()).rentReturned.gtn(0)).to.equal(true);
    expect(await provider.connection.getMultipleAccountsInfo([nft.publicKey,k.open.nftAccount,k.open.personalPosition])).to.deep.equal([null,null,null]);
    expect((await program.account.vaultConfig.fetch(k.open.core.vault)).version).to.equal(0x81);
  });
  it("rejects repeated close and management of a closed NFT",async()=>{
    await rejects(()=>close().rpc(),/AccountOwnedByWrongProgram|ConstraintOwner|InvalidLiquidityPosition/);
    await rejects(()=>collect().rpc(),/AccountOwnedByWrongProgram|ConstraintOwner|InvalidLiquidityPosition/);
  });
  it("blocks end until B is converted, then restores ordinary deposits/withdrawals",async()=>{
    await rejects(()=>end().rpc(),/UnsettledStrategy/);
    await swap(false,(await balances()).b); await end().rpc();
    expect((await program.account.vaultConfig.fetch(k.open.core.vault)).version).to.equal(1);
    await program.methods.deposit(bn(1000),bn(1)).accountsStrict(userKeys(f.asset,user.publicKey)).signers([user]).rpc();
    const history=(await program.account.userPosition.fetch(userKeys(f.asset,user.publicKey).position)).shares;
    await program.methods.withdraw(bn(1000),bn(1)).accountsStrict(userKeys(f.asset,user.publicKey)).signers([user]).rpc();
    expect((await balances()).b).to.equal(0n); expect((await program.account.userPosition.fetch(userKeys(f.asset,user.publicKey).position)).shares.eq(history)).to.equal(true);
  });
});
