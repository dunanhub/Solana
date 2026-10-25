// Read-only Devnet download: local tests execute the actual CLMM ELF, not a mock.
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { PoolInfoLayout, ObservationLayout, TickArrayLayout, TickArrayBitmapExtensionLayout } from "@raydium-io/raydium-sdk-v2";
import { CLMM, CONFIG, GENESIS, RPC, check, checkConfig } from "../raydium/config";
import { connection, readRpc } from "../raydium/runtime";

async function main() {
  const rpc = connection();
  check(rpc.rpcEndpoint === RPC && await readRpc(() => rpc.getGenesisHash()) === GENESIS, "Devnet required");
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const program = await readRpc(() => rpc.getAccountInfo(CLMM));
  check(program?.executable && program.owner.equals(loader) && program.data.readUInt32LE(0) === 2, "Invalid CLMM program");
  const programDataAddress = new PublicKey(program.data.subarray(4, 36));
  const [data, config] = await readRpc(() => rpc.getMultipleAccountsInfo([programDataAddress, CONFIG]));
  check(data !== null && data.owner.equals(loader) && data.data.readUInt32LE(0) === 3, "Invalid CLMM ProgramData");
  checkConfig(CONFIG, config);
  const elf = data.data.subarray(45);
  check(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), "Missing ELF header");
  check(PoolInfoLayout.span === 1544 && ObservationLayout.span === 4483 && TickArrayLayout.span === 10240
    && TickArrayBitmapExtensionLayout.span === 1832, "Raydium layout version changed");
  const root = path.resolve(__dirname, "../../target/fixtures");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "raydium-clmm.so"), elf);
  fs.writeFileSync(path.join(root, "raydium-config.json"), JSON.stringify({ pubkey: CONFIG.toBase58(), account: {
    lamports: config!.lamports, data: [config!.data.toString("base64"), "base64"], owner: CLMM.toBase58(),
    executable: false, rentEpoch: 0,
  } }, null, 2));
  const source = "https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_clmm/raydium_clmm.json";
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  check(response.ok, `Official IDL unavailable: ${response.status}`);
  const idl = await response.json() as { instructions: { name: string; discriminator?: number[]; accounts: unknown[]; args: unknown[] }[] };
  const swap = idl.instructions.find((ix) => ["swapV2", "swap_v2"].includes(ix.name));
  check(swap, "Official IDL has no SwapV2");
  const manifest = { program: CLMM.toBase58(), programData: programDataAddress.toBase58(),
    deployedSlot: data.data.readBigUInt64LE(4).toString(), sha256: createHash("sha256").update(elf).digest("hex"),
    bytes: elf.length, config: CONFIG.toBase58(), idlSource: source, swapV2: swap };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
