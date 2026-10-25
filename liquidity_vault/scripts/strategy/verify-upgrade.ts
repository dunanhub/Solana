// Read-only verification of an already finalized upgrade; never sends transactions.
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { WALLET, CLMM, check, checkNetwork } from "../raydium/config";
import { connection, readRpc } from "../raydium/runtime";
import { VAULT_PROGRAM } from "./client";

async function main() {
  const signature = process.argv[2]; check(signature, "Pass the already finalized upgrade signature");
  const rpc = connection();
  checkNetwork(rpc.rpcEndpoint, await readRpc(() => rpc.getGenesisHash()), CLMM);
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const buffer = new PublicKey("AjAYGJk7P9HqSnVhNX29NDm6gyrxgVZB1NgieZfkacmj");
  const executable = await readRpc(() => rpc.getAccountInfo(VAULT_PROGRAM));
  check(executable !== null && executable.owner.equals(loader) && executable.executable
    && executable.data.readUInt32LE(0) === 2, "Invalid executable");
  const programData = new PublicKey(executable.data.subarray(4, 36));
  const [data, remainingBuffer] = await readRpc(() => rpc.getMultipleAccountsInfo([programData, buffer]));
  check(data !== null && data.owner.equals(loader) && data.data.readUInt32LE(0) === 3
    && data.data[12] === 1 && new PublicKey(data.data.subarray(13, 45)).equals(WALLET), "Wrong ProgramData/authority");
  check(remainingBuffer === null, "Upgrade buffer is not closed");
  const local = fs.readFileSync(path.resolve(__dirname, "../../target/deploy/liquidity_vault.so"));
  const deployed = data.data.subarray(45);
  check(deployed.length >= local.length && deployed.subarray(0, local.length).equals(local)
    && deployed.subarray(local.length).every((value) => value === 0), "Deployed binary mismatch");
  const tx = await readRpc(() => rpc.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
  check(tx?.meta && tx.meta.err === null && BigInt(tx.slot) === data.data.readBigUInt64LE(4), "Upgrade is not the current finalized deployment");
  const upgrade = tx.transaction.message.instructions.find((ix) => ix.programId.equals(loader) && "parsed" in ix && ix.parsed.type === "upgrade");
  check(upgrade && "parsed" in upgrade && upgrade.parsed.info.programAccount === VAULT_PROGRAM.toBase58()
    && upgrade.parsed.info.programDataAccount === programData.toBase58()
    && upgrade.parsed.info.bufferAccount === buffer.toBase58()
    && upgrade.parsed.info.authority === WALLET.toBase58(), "Wrong loader upgrade instruction");
  const proof = { cluster: "devnet", program: VAULT_PROGRAM.toBase58(), programData: programData.toBase58(),
    authority: WALLET.toBase58(), signature, slot: tx.slot, finalized: true, binaryMatches: true,
    binaryBytes: local.length, allocatedBytes: deployed.length,
    sha256: createHash("sha256").update(local).digest("hex"), buffer: buffer.toBase58(), bufferClosed: true,
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, "upgrade-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
