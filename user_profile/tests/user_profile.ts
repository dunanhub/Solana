import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import assert from "assert";
import { UserProfile } from "../target/types/user_profile";

describe("user_profile", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.UserProfile as Program<UserProfile>;
  const [profilePda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  it("creates and updates a profile on Devnet", async () => {
    console.log("Program ID:", program.programId.toBase58());
    console.log("Owner wallet:", provider.wallet.publicKey.toBase58());
    console.log("Profile PDA:", profilePda.toBase58());
    console.log("PDA bump:", bump);

    const createSignature = await program.methods
      .createProfile("Bekzat", "Solana developer profile")
      .accountsStrict({
        profile: profilePda,
        owner: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("Create transaction signature:", createSignature);

    const createdProfile = await program.account.userProfile.fetch(profilePda);
    console.log("Owner:", createdProfile.owner.toBase58());
    console.log("Username:", createdProfile.username);
    console.log("Bio:", createdProfile.bio);
    console.log("Bump:", createdProfile.bump);

    assert.strictEqual(createdProfile.username, "Bekzat");
    assert.strictEqual(createdProfile.bio, "Solana developer profile");
    assert.strictEqual(
      createdProfile.owner.toBase58(),
      provider.wallet.publicKey.toBase58()
    );

    const updateSignature = await program.methods
      .updateProfile("Bekzat Web3", "Updated on-chain Solana profile")
      .accountsStrict({
        profile: profilePda,
        owner: provider.wallet.publicKey,
      })
      .rpc();
    console.log("Update transaction signature:", updateSignature);

    const updatedProfile = await program.account.userProfile.fetch(profilePda);
    console.log("Updated username:", updatedProfile.username);
    console.log("Updated bio:", updatedProfile.bio);

    assert.strictEqual(updatedProfile.username, "Bekzat Web3");
    assert.strictEqual(updatedProfile.bio, "Updated on-chain Solana profile");
  });
});
