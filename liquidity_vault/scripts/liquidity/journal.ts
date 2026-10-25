import { Connection,Keypair,Transaction,TransactionInstruction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { check } from "../raydium/config";
import { readRpc,confirmReceipt } from "../raydium/runtime";
import { Journal } from "../strategy/journal";
export { retireExpiredStep } from "../strategy/journal";
export type { Journal } from "../strategy/journal";
export async function sendOnce(rpc:Connection,wallet:Keypair,state:Journal,name:string,
  build:()=>Promise<{instructions:TransactionInstruction[];signers?:Keypair[]}>,persist:()=>void) {
  if(!state.receipts[name]) {
    const plan=await build(),latest=await readRpc(()=>rpc.getLatestBlockhash("confirmed"));
    const tx=new Transaction({feePayer:wallet.publicKey,...latest}).add(...plan.instructions);
    tx.sign(wallet,...(plan.signers??[]));
    const signature=utils.bytes.bs58.encode(tx.signature!);
    state.receipts[name]={signature,...latest,status:"pending"};persist();console.log(`${name}: ${signature}`);
    try {check(await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:"confirmed",maxRetries:0})===signature,"Wrong RPC signature");}
    catch(e){state.receipts[name].broadcastError=String(e);persist();console.warn(`${name}: checking saved signature; no resend`);}
  }
  check(state.receipts[name].status!=="failed",`Recorded failed ${name}; reconcile before any new action`);
  try{await confirmReceipt(rpc,state.receipts[name]);}finally{persist();}
}
