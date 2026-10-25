import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair,PublicKey,TransactionInstruction } from "@solana/web3.js";
import { getPdaPersonalPositionAddress } from "@raydium-io/raydium-sdk-v2";
import { CLMM,WALLET,check } from "../raydium/config";
import { connection,loadWallet,outsideRepository,readRpc } from "../raydium/runtime";
import { VAULT_PROGRAM,manageKeys,swapKeys } from "../strategy/client";
import { Journal,sendOnce,retireExpiredStep } from "./journal";
import { chooseRange,positionKeys,liquidityQuote,withdrawalQuote,externalSwap,poolState,compute,bn } from "./client";
import { A,B,POOL,v,u,s,recordAddress,deployment,snapshot,protectedAccounts,inspectTransaction,verifyUpgrade,link,Snapshot } from "./verify";
import { LiquidityVault } from "../../target/types/liquidity_vault";

const root=path.resolve(__dirname,"../.."),dir=path.join(os.homedir(),".config/solana/liquidity_vault/week13-liquidity");
const statePath=path.join(dir,"state.json"),keyPath=path.join(dir,"position-nft-keypair.json");
const rpc=connection(),pause=()=>new Promise<void>(resolve=>setTimeout(resolve,10_000));
interface State extends Journal {version:1;cluster:"devnet";program:string;wallet:string;pool:string;nftMint:string;binaryHash:string;
  baseline:Record<string,string>;snapshots:Record<string,Snapshot>;range?:{lower:number;upper:number};
  quotes:Record<string,Record<string,string>>;}
function save(state:State){fs.writeFileSync(`${statePath}.tmp`,JSON.stringify(state,null,2)+"\n",{mode:0o600});fs.renameSync(`${statePath}.tmp`,statePath);}
function nftKey(create=false) {
  if(!fs.existsSync(keyPath)){check(create,"Existing NFT key is missing; never create a replacement");
    fs.writeFileSync(keyPath,JSON.stringify(Array.from(Keypair.generate().secretKey)),{flag:"wx",mode:0o600});}
  outsideRepository(keyPath);return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath,"utf8"))));
}
async function main(){
  const command=process.argv[2]??"check";
  check(["check","run","verify","verify-upgrade","recover-expired"].includes(command),"Use check/run/verify/verify-upgrade/recover-expired");
  if(command==="verify-upgrade"){check(process.argv[3],"Upgrade signature required");console.log(JSON.stringify(await verifyUpgrade(rpc,process.argv[3]),null,2));return;}
  const deploy=await deployment(rpc);console.log(JSON.stringify(deploy,null,2));
  const readonlyWallet={publicKey:WALLET,signTransaction:async()=>{throw new Error("Read-only");},signAllTransactions:async()=>{throw new Error("Read-only");}};
  const wallet=command==="run"?loadWallet():null;
  const provider=new anchor.AnchorProvider(rpc,wallet?new anchor.Wallet(wallet):readonlyWallet,{commitment:"finalized",preflightCommitment:"confirmed",skipPreflight:false});
  const program=new anchor.Program<LiquidityVault>(JSON.parse(fs.readFileSync(path.join(root,"target/idl/liquidity_vault.json"),"utf8")),provider);
  if(command==="check"){
    const state=await snapshot(rpc,program);
    const result={...deploy,checkedAt:new Date().toISOString(),state};
    fs.writeFileSync(path.join(__dirname,"devnet-status.json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(state,null,2));return;
  }
  check(deploy.binaryMatches,"Upgrade and verify the current binary first");
  fs.mkdirSync(dir,{recursive:true,mode:0o700});outsideRepository(dir);
  const lockPath=path.join(dir,"run.lock"),fd=fs.openSync(lockPath,"wx",0o600);
  const release=()=>{if(fs.existsSync(lockPath)){fs.closeSync(fd);fs.unlinkSync(lockPath);}};
  process.once("exit",release);process.once("SIGINT",()=>process.exit(130));process.once("SIGTERM",()=>process.exit(143));
  try{
    let state:State;
    if(fs.existsSync(statePath))state=JSON.parse(fs.readFileSync(statePath,"utf8"));
    else{
      check(command==="run","Missing Week 13 journal");
      const before=await snapshot(rpc,program);
      check(!before.active&&before.version===1&&before.b==="0"&&before.recordedB==="0"&&before.a==="999950"&&before.supply==="1000000"&&!before.record,"Unexpected initial Week 12 state");
      const nft=nftKey(true);
      state={version:1,cluster:"devnet",program:VAULT_PROGRAM.toBase58(),wallet:WALLET.toBase58(),pool:POOL.toBase58(),nftMint:nft.publicKey.toBase58(),
        binaryHash:deploy.binaryHash,baseline:await protectedAccounts(rpc),receipts:{},snapshots:{before},quotes:{}};save(state);
    }
    check(state.version===1&&state.cluster==="devnet"&&state.program===VAULT_PROGRAM.toBase58()&&state.wallet===WALLET.toBase58()
      &&state.pool===POOL.toBase58()&&state.binaryHash===deploy.binaryHash,"Unexpected saved Week 13 journal");
    const mint=new PublicKey(state.nftMint);
    const unchanged=async()=>check(JSON.stringify(await protectedAccounts(rpc))===JSON.stringify(state.baseline),"Protected Week 9/11 state changed");
    await unchanged();
    if(command==="recover-expired"){
      const name=process.argv[3];check(name&&state.receipts[name]&&!state.snapshots[name],"Specify an incomplete saved step");
      const last=Object.values(state.snapshots).at(-1)!;
      const now=await snapshot(rpc,program,mint);
      // Public pool state may move, but all Vault/NFT/position/share/wallet balances must still agree.
      for(const field of ["a","b","supply","userA","userB","userShares","history","version","active","recordedB","swapCount","record","position","nft"] as const)
        check(JSON.stringify(now[field])===JSON.stringify(last[field]),`State changed: ${field}`);
      await retireExpiredStep(rpc,state,name,()=>save(state));console.log(JSON.stringify(state.retired,null,2));return;
    }
    const current=()=>snapshot(rpc,program,mint);
    async function step(name:string,build:()=>Promise<{instructions:TransactionInstruction[];signers?:Keypair[]}>,validate:(s:Snapshot)=>void){
      if(state.snapshots[name]){check(state.receipts[name]?.status==="finalized","Snapshot without finalized receipt");return;}
      check(command==="run"&&wallet,"Incomplete workflow: use run");
      check(await readRpc(()=>rpc.getBalance(WALLET))>=100_000_000,"Keep 0.1 test SOL for rent and recovery");
      await sendOnce(rpc,wallet,state,name,build,()=>save(state));
      const after=await current();validate(after);state.snapshots[name]=after;save(state);await unchanged();await pause();
    }
    const one=async(ix:Promise<TransactionInstruction>)=>({instructions:[compute,await ix]});
    const keys=async()=>{check(state.range,"Missing saved range");return positionKeys(rpc,A,B,POOL,WALLET,mint,state.range.lower,state.range.upper);};
    const active=(a:Snapshot)=>check(a.active&&[0x81,0xc1].includes(a.version)&&a.supply===state.snapshots.before.supply,"Wrong active state/share supply");
    await step("start",()=>one(program.methods.startStrategy().accountsStrict(manageKeys(A,B,WALLET)).instruction()),active);
    async function swap(name:string,aToB:boolean){await step(name,async()=>{
      const before=await current(),amount=aToB?450000n:BigInt(before.b);check(amount>0n,"Empty swap input");
      const sk=await swapKeys(rpc,A,B,POOL,WALLET,aToB);
      const method=(min:bigint)=>program.methods.swap(aToB,bn(amount),bn(min),sk.limit).accountsStrict(sk.accounts).remainingAccounts(sk.ticks).preInstructions([compute]);
      const simulated=await method(1n).simulate(),event=simulated.events.find(e=>e.name==="strategySwapEvent");check(event,"Missing swap simulation event");
      const output=BigInt(event.data.received.toString()),minimum=output*99n/100n;check(minimum>0n,"Zero minimum");
      state.quotes[name]={amount:amount.toString(),minimum:minimum.toString(),limit:sk.limit.toString(),simulatedOutput:output.toString()};save(state);
      return one(method(minimum).instruction());
    },after=>{active(after);check(aToB?BigInt(after.b)>400000n:after.b==="0"&&after.recordedB==="0","Wrong swap result");});}
    await swap("prepareB",true);
    await step("open",async()=>{
      const p=await poolState(rpc,POOL);state.range=chooseRange(p.tickCurrent,p.tickSpacing);save(state);
      const k=await keys(),nft=nftKey();check(nft.publicKey.equals(mint),"Wrong saved NFT signer");
      return {instructions:[compute,await program.methods.openLiquidityPosition(state.range.lower,state.range.upper).accountsStrict(k.open).instruction()],signers:[nft]};
    },after=>{active(after);check(after.version===0xc1&&after.record?.open&&after.position?.liquidity==="0"
      &&after.nft?.owner===v.vault.toBase58()&&after.nft.amount==="1"&&after.nft.supply==="1","Wrong Vault NFT ownership");});
    await step("increase",async()=>{
      const k=await keys(),p=await poolState(rpc,POOL),q=liquidityQuote(p.sqrtPriceX64,state.range!.lower,state.range!.upper,bn(350000),bn(350000));
      state.quotes.increase={liquidity:q.liquidity.toString(),amountA:q.amount0.toString(),amountB:q.amount1.toString(),maxA:q.max0.toString(),maxB:q.max1.toString()};save(state);
      return one(program.methods.increaseLiquidity(q.liquidity,q.max0,q.max1).accountsStrict(k.manage).instruction());
    },after=>{active(after);check(after.position?.liquidity===state.quotes.increase.liquidity&&after.record?.liquidity===after.position.liquidity
      &&BigInt(after.record.depositedA)>0n&&BigInt(after.record.depositedB)>0n,"Liquidity was not added");});
    await step("externalSwap",async()=>({instructions:[compute,await externalSwap(rpc,A,B,POOL,WALLET,bn(100000),bn(98000))]}),after=>{
      active(after);const before=state.snapshots.increase;
      check(after.a===before.a&&after.b===before.b&&after.position?.liquidity===before.position?.liquidity,"External swap changed Vault cash/liquidity");
      check(BigInt(before.userA)-BigInt(after.userA)===100000n&&BigInt(after.userB)>BigInt(before.userB),"External swap did not use wallet balances");
      check(after.tick>=state.range!.lower&&after.tick<state.range!.upper,"External trade left position range");
    });
    await step("collect",async()=>one(program.methods.collectFees(bn(1),bn(0)).accountsStrict((await keys()).manage).instruction()),after=>{
      active(after);check(after.record!==null&&BigInt(after.record.feesA)>0n&&BigInt(after.a)>BigInt(state.snapshots.externalSwap.a)
        &&after.position?.liquidity===state.snapshots.increase.position?.liquidity,"No real positive fee collection");});
    async function remove(name:string,half:boolean){await step(name,async()=>{
      const k=await keys(),before=await current(),amount=bn(before.record!.liquidity);const liquidity=half?amount.divn(2):amount;
      const p=await poolState(rpc,POOL),q=withdrawalQuote(p.sqrtPriceX64,state.range!.lower,state.range!.upper,liquidity);
      state.quotes[name]={liquidity:liquidity.toString(),minA:q.min0.toString(),minB:q.min1.toString()};save(state);
      return one(program.methods.decreaseLiquidity(liquidity,q.min0,q.min1).accountsStrict(k.manage).instruction());
    },after=>{active(after);check(after.record?.open&&(half?BigInt(after.record.liquidity)>0n:after.record.liquidity==="0")&&after.position?.liquidity===after.record.liquidity,"Wrong decrease state");});}
    await remove("decreasePartial",true);await remove("decreaseAll",false);
    await step("close",async()=>one(program.methods.closeLiquidityPosition().accountsStrict((await keys()).close).instruction()),after=>{
      active(after);check(after.record?.open===false&&after.record.liquidity==="0"&&!after.personalExists&&!after.mintExists&&after.nft===null&&after.version===0x81,"Position/NFT not actually closed");});
    await swap("convertToA",false);
    await step("end",()=>one(program.methods.endStrategy().accountsStrict(manageKeys(A,B,WALLET)).instruction()),after=>{
      check(!after.active&&after.version===1&&after.b==="0"&&after.recordedB==="0"&&!after.record?.open,"Unsafe end state");});
    await step("depositAfterEnd",async()=>{
      const before=await current(),shares=1000n*BigInt(before.supply)/BigInt(before.a);
      return one(program.methods.deposit(bn(1000),bn(shares)).accountsStrict(u).instruction());
    },after=>check(BigInt(after.a)===BigInt(state.snapshots.end.a)+1000n&&BigInt(after.supply)>BigInt(state.snapshots.end.supply),"Post-end deposit failed"));
    await step("withdrawAfterEnd",async()=>{
      const before=await current(),amount=1000n*BigInt(before.a)/BigInt(before.supply);
      return one(program.methods.withdraw(bn(1000),bn(amount)).accountsStrict(u).instruction());
    },after=>check(BigInt(after.supply)===BigInt(state.snapshots.depositAfterEnd.supply)-1000n&&after.history===state.snapshots.depositAfterEnd.history,"Post-end withdrawal failed"));
    const final=await current();check(JSON.stringify(final)===JSON.stringify(state.snapshots.withdrawAfterEnd),"Final state differs from journal");
    check(!final.active&&!final.personalExists&&!final.mintExists&&final.nft===null&&final.record?.open===false&&final.b==="0"&&final.recordedB==="0","Unsafe final state");
    const entries=Object.entries(state.receipts),statuses=(await readRpc(()=>rpc.getSignatureStatuses(entries.map(([,r])=>r.signature),{searchTransactionHistory:true}))).value;
    check(statuses.every((s,i)=>s?.confirmationStatus==="finalized"&&s.err===null&&s.slot===entries[i][1].slot),"Receipt not finalized");
    const expected:Record<string,string[]>={start:[],prepareB:["swap_v2"],open:["open_position_with_token22_nft"],increase:["increase_liquidity_v2"],externalSwap:["swap_v2"],
      collect:["decrease_liquidity_v2"],decreasePartial:["decrease_liquidity_v2"],decreaseAll:["decrease_liquidity_v2"],close:["close_position"],convertToA:["swap_v2"],end:[],depositAfterEnd:[],withdrawAfterEnd:[]};
    const transactions=[];
    for(const [name,receipt] of entries){transactions.push({step:name,...await inspectTransaction(rpc,program,receipt.signature,expected[name],name==="externalSwap")});
      await new Promise<void>(resolve=>setTimeout(resolve,1000));}
    await unchanged();
    const proof={...state,verifiedAt:new Date().toISOString(),deployment:deploy,addresses:{vault:v.vault.toBase58(),strategy:v.strategy.toBase58(),record:recordAddress.toBase58(),
      position:getPdaPersonalPositionAddress(CLMM,mint).publicKey.toBase58(),nftMint:mint.toBase58(),nftOwnerWhileOpen:v.vault.toBase58()},final,transactions,
      realizedStrategyDeltaA:(BigInt(state.snapshots.end.a)-BigInt(state.snapshots.before.a)).toString(),
      externalTrade:{payer:WALLET.toBase58(),source:"personal wallet ATA, not Vault",amountA:"100000",count:1},
      links:Object.fromEntries(entries.map(([n,r])=>[n,link(r.signature)]))};
    fs.writeFileSync(path.join(__dirname,"devnet-proof.json"),JSON.stringify(proof,null,2)+"\n");
    fs.writeFileSync(path.join(__dirname,"asset-report.json"),JSON.stringify({warning:"Analytical spot marks, not a production NAV",snapshots:state.snapshots,
      collectedFees:{a:final.record!.feesA,b:final.record!.feesB},realizedStrategyDeltaA:proof.realizedStrategyDeltaA},null,2)+"\n");
    console.log(JSON.stringify({verified:true,final,realizedStrategyDeltaA:proof.realizedStrategyDeltaA,receipts:state.receipts},null,2));
  }finally{release();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
