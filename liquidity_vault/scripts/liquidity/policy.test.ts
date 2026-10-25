import { expect } from "chai";
import { Connection,Keypair,SystemProgram,Transaction } from "@solana/web3.js";
import { chooseRange,liquidityQuote,withdrawalQuote,spotQuoteToAsset,limits,bn,externalSwap } from "./client";
import { sendOnce,Journal } from "./journal";

describe("Week 13 liquidity safeguards (offline)",()=>{
  async function fails(fn:()=>Promise<unknown>,message:string){let error:unknown;try{await fn();}catch(e){error=e;}expect(String(error)).to.include(message);}
  it("chooses a range from the actual negative tick",()=>{expect(chooseRange(-1,60)).to.deep.equal({lower:-660,upper:540});expect(chooseRange(-3610,60)).to.deep.equal({lower:-4260,upper:-3060});});
  it("chooses a different range after a positive price move",()=>{expect(chooseRange(700,60)).to.deep.equal({lower:60,upper:1260});});
  it("rejects invalid spacing, fractional ticks and unsupported edge ranges",()=>{
    for(const [tick,spacing] of [[0,0],[0,-60],[0.5,60],[443636,60],[-443636,60]])expect(()=>chooseRange(tick,spacing)).to.throw();
  });
  it("quotes both tokens and positive liquidity within the budgets",()=>{
    const q=liquidityQuote(bn(1n<<64n),-660,540,bn(350000),bn(350000));
    expect(q.liquidity.gtn(0)&&q.amount0.gtn(0)&&q.amount1.gtn(0)).to.equal(true);
    expect(q.amount0.lten(350000)&&q.amount1.lten(350000)).to.equal(true);
    expect(q.max0.gte(q.amount0)&&q.max1.gte(q.amount1)).to.equal(true);
  });
  it("rounds deposited amounts upward and withdrawal amounts downward",()=>{
    const sqrt=bn(1n<<64n),q=liquidityQuote(sqrt,-600,600,bn(100000),bn(100000));
    const out=withdrawalQuote(sqrt,-600,600,q.liquidity);
    expect(out.amount0.lte(q.amount0)&&out.amount1.lte(q.amount1)).to.equal(true);
    expect(out.min0.lte(out.amount0)&&out.min1.lte(out.amount1)).to.equal(true);
  });
  it("rejects zero budgets and a price outside the selected position",()=>{
    expect(()=>liquidityQuote(bn(1n<<64n),-600,600,bn(0),bn(100))).to.throw("budgets");
    expect(()=>liquidityQuote(bn(1n<<65n),-600,600,bn(100),bn(100))).to.throw("straddle");
  });
  it("rounds tiny slippage bounds conservatively",()=>{expect(limits(bn(1),true).toString()).to.equal("2");expect(limits(bn(1),false).toString()).to.equal("0");expect(()=>limits(bn(-1),true)).to.throw();});
  it("converts B to A rather than adding unlike token units",()=>{
    expect(spotQuoteToAsset(100n,2n<<64n,true)).to.equal(25n);
    expect(spotQuoteToAsset(100n,2n<<64n,false)).to.equal(400n);
  });
  it("uses integer floor and full precision for analytical spot conversion",()=>{
    expect(spotQuoteToAsset(3n,2n<<64n,true)).to.equal(0n);
    const huge=(1n<<64n)-1n;expect(spotQuoteToAsset(huge,1n<<64n,true)).to.equal(huge);
    expect(()=>spotQuoteToAsset(-1n,1n,true)).to.throw();expect(()=>spotQuoteToAsset(1n,0n,true)).to.throw();
  });
  it("rejects an external trade above the one-shot demo cap before RPC",async()=>{
    const key=Keypair.generate().publicKey;
    await fails(()=>externalSwap({} as Connection,key,key,key,key,bn(100001),bn(1)),"capped");
  });
  it("saves and signs the same NFT transaction before broadcast",async()=>{
    const wallet=Keypair.generate(),nft=Keypair.generate(),state:Journal={receipts:{}};let saved=false,sends=0;
    const rpc={getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),
      sendRawTransaction:async(raw:Buffer,opts:unknown)=>{expect(saved).to.equal(true);expect(opts).to.deep.equal({skipPreflight:false,preflightCommitment:"confirmed",maxRetries:0});
        expect(Transaction.from(raw).verifySignatures()).to.equal(true);expect(Transaction.from(raw).signatures.length).to.equal(2);sends++;throw new Error("lost response");},
      getSignatureStatuses:async()=>({value:[{err:null,confirmationStatus:"finalized",slot:7}]})} as unknown as Connection;
    await sendOnce(rpc,wallet,state,"open",async()=>({instructions:[SystemProgram.createAccount({fromPubkey:wallet.publicKey,newAccountPubkey:nft.publicKey,lamports:1,space:0,programId:SystemProgram.programId})],signers:[nft]}),()=>{saved=true;});
    await sendOnce(rpc,wallet,state,"open",async()=>{throw new Error("must not generate a second NFT");},()=>{});
    expect(sends).to.equal(1);expect(state.receipts.open.status).to.equal("finalized");
  });
  it("never sends when signature persistence fails",async()=>{
    const wallet=Keypair.generate();let sends=0;
    const rpc={getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),sendRawTransaction:async()=>{sends++;}} as unknown as Connection;
    await fails(()=>sendOnce(rpc,wallet,{receipts:{}},"open",async()=>({instructions:[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:wallet.publicKey,lamports:0})]}),()=>{throw new Error("disk full");}),"disk full");expect(sends).to.equal(0);
  });
  it("a recorded failed instruction cannot create a fresh position",async()=>{
    const state:Journal={receipts:{open:{signature:"failed",blockhash:"old",lastValidBlockHeight:1,status:"failed"}}};
    await fails(()=>sendOnce({} as Connection,Keypair.generate(),state,"open",async()=>{throw new Error("must not build");},()=>{}),"Recorded failed");
  });
});
