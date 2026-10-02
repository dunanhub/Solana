import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { AnchorCounter } from "../target/types/anchor_counter";

describe("anchor_counter", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorCounter as Program<AnchorCounter>;

  it("initializes and increments a counter", async () => {
    const counter = anchor.web3.Keypair.generate();

    console.log("Program ID:", program.programId.toBase58());
    console.log("Counter account public key:", counter.publicKey.toBase58());

    const initializeSignature = await program.methods
      .initialize()
      .accountsStrict({
        counter: counter.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([counter])
      .rpc();
    console.log("initialize transaction signature:", initializeSignature);

    const afterInitialize = await program.account.counter.fetch(counter.publicKey);
    console.log("Counter after initialize:", afterInitialize.count.toNumber());
    assert.equal(afterInitialize.count.toNumber(), 0);

    const incrementSignature = await program.methods
      .increment()
      .accounts({ counter: counter.publicKey })
      .rpc();
    console.log("increment transaction signature:", incrementSignature);

    const afterIncrement = await program.account.counter.fetch(counter.publicKey);
    console.log("Counter after increment:", afterIncrement.count.toNumber());
    assert.equal(afterIncrement.count.toNumber(), 1);
  });
});
