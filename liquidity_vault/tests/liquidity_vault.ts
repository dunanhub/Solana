import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  createAccount,
  createMint,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("liquidity_vault — Week 8", () => {
  const provider = anchor.AnchorProvider.env();
  // These tests create disposable assets and must never spend on a public cluster.
  const host = new URL(provider.connection.rpcEndpoint).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error("Integration tests require a local validator");
  }
  anchor.setProvider(provider);
  const program = anchor.workspace.LiquidityVault as anchor.Program<LiquidityVault>;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const user = Keypair.generate();
  const otherUser = Keypair.generate();
  const decimals = 6;

  function addresses(assetMint: PublicKey) {
    const [vault, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetMint.toBuffer()], program.programId,
    );
    const [shareMint, shareMintBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("share-mint"), vault.toBuffer()], program.programId,
    );
    const [tokenVault, tokenVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("token-vault"), vault.toBuffer()], program.programId,
    );
    return { assetMint, vault, shareMint, tokenVault, bump, shareMintBump, tokenVaultBump };
  }
  type VaultAddresses = ReturnType<typeof addresses>;
  let main: VaultAddresses;
  let second: VaultAddresses;
  let fresh: VaultAddresses;

  function position(vault: PublicKey, owner: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vault.toBuffer(), owner.toBuffer()], program.programId,
    );
  }

  function initAccounts(a: VaultAddresses) {
    return {
      administrator: payer.publicKey,
      assetMint: a.assetMint,
      vault: a.vault,
      shareMint: a.shareMint,
      tokenVault: a.tokenVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  function openAccounts(a: VaultAddresses, owner = user.publicKey) {
    const { administrator: _, ...accounts } = initAccounts(a);
    return { ...accounts, user: owner, position: position(a.vault, owner)[0] };
  }

  async function rejects(action: () => Promise<unknown>, reason: RegExp) {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    expect(caught, "transaction unexpectedly succeeded").not.to.equal(undefined);
    const error = caught as { logs?: string[]; message?: string };
    const details = [String(caught), error.message, ...(error.logs ?? [])].join("\n");
    expect(details).to.match(reason);
  }

  async function withoutSigner(ix: TransactionInstruction, signer: PublicKey) {
    const meta = ix.keys.find((key) => key.pubkey.equals(signer));
    if (!meta) throw new Error("Missing signer account in test instruction");
    meta.isSigner = false;
    return provider.sendAndConfirm(new Transaction().add(ix));
  }

  before(async () => {
    await provider.sendAndConfirm(new Transaction().add(
      ...[user, otherUser].map((owner) => SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: owner.publicKey,
        lamports: LAMPORTS_PER_SOL,
      })),
    ));
    main = addresses(await createMint(provider.connection, payer, payer.publicKey, null, decimals));
    second = addresses(await createMint(provider.connection, payer, payer.publicKey, null, 9));
    fresh = addresses(await createMint(provider.connection, payer, payer.publicKey, null, decimals));
    await program.methods.initializeVault().accountsStrict(initAccounts(second)).rpc();
  });

  it("initializes the vault and records the signing administrator", async () => {
    await program.methods.initializeVault().accountsStrict(initAccounts(main)).rpc();
    const vault = await program.account.vaultConfig.fetch(main.vault);
    expect(vault.administrator.equals(payer.publicKey)).to.equal(true);
    expect(vault.assetMint.equals(main.assetMint)).to.equal(true);
    expect(vault.shareMint.equals(main.shareMint)).to.equal(true);
    expect(vault.tokenVault.equals(main.tokenVault)).to.equal(true);
    expect(vault.version).to.equal(1);
  });

  it("uses canonical PDAs, stored bumps, ownership and exact account sizes", async () => {
    const vault = await program.account.vaultConfig.fetch(main.vault);
    expect([vault.bump, vault.shareMintBump, vault.tokenVaultBump])
      .to.deep.equal([main.bump, main.shareMintBump, main.tokenVaultBump]);
    for (const address of [main.vault, main.shareMint, main.tokenVault]) {
      expect(PublicKey.isOnCurve(address.toBytes())).to.equal(false);
    }
    const info = await provider.connection.getAccountInfo(main.vault);
    expect(info!.owner.equals(program.programId)).to.equal(true);
    expect(info!.data.length).to.equal(140);
  });

  it("creates an empty share mint controlled only by the Vault PDA", async () => {
    const mint = await getMint(provider.connection, main.shareMint);
    expect(mint.mintAuthority!.equals(main.vault)).to.equal(true);
    expect(mint.freezeAuthority).to.equal(null);
    expect(mint.decimals).to.equal(decimals);
    expect(mint.supply).to.equal(0n);
    expect(mint.isInitialized).to.equal(true);
  });

  it("creates an empty token vault with the correct asset and authority", async () => {
    const account = await getAccount(provider.connection, main.tokenVault);
    expect(account.mint.equals(main.assetMint)).to.equal(true);
    expect(account.owner.equals(main.vault)).to.equal(true);
    expect(account.amount).to.equal(0n);
    expect(account.delegate).to.equal(null);
    expect(account.closeAuthority).to.equal(null);
    expect(account.isFrozen).to.equal(false);
  });

  it("rejects repeated initialization without changing the administrator", async () => {
    await rejects(() => program.methods.initializeVault().accountsStrict({
      ...initAccounts(main), administrator: otherUser.publicKey,
    }).signers([otherUser]).rpc(), /already in use/);
    const vault = await program.account.vaultConfig.fetch(main.vault);
    expect(vault.administrator.equals(payer.publicKey)).to.equal(true);
  });

  it("opens a user position bound to its vault and signing user", async () => {
    await program.methods.openPosition().accountsStrict(openAccounts(main)).signers([user]).rpc();
    const [address, bump] = position(main.vault, user.publicKey);
    const state = await program.account.userPosition.fetch(address);
    expect(state.user.equals(user.publicKey)).to.equal(true);
    expect(state.vault.equals(main.vault)).to.equal(true);
    expect(state.bump).to.equal(bump);
    expect(state.shares.toString()).to.equal("0");
    const info = await provider.connection.getAccountInfo(address);
    expect(info!.owner.equals(program.programId)).to.equal(true);
    expect(info!.data.length).to.equal(81);
  });

  it("rejects a duplicate position without resetting it", async () => {
    const address = position(main.vault, user.publicKey)[0];
    const before = (await provider.connection.getAccountInfo(address))!.data;
    // Make a distinct transaction even if the previous call used the same blockhash.
    await rejects(() => program.methods.openPosition().accountsStrict(openAccounts(main))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })])
      .signers([user]).rpc(), /already in use/);
    expect((await provider.connection.getAccountInfo(address))!.data.equals(before)).to.equal(true);
  });

  it("allows independent positions for different users", async () => {
    await program.methods.openPosition().accountsStrict(openAccounts(main, otherUser.publicKey))
      .signers([otherUser]).rpc();
    const address = position(main.vault, otherUser.publicKey)[0];
    const state = await program.account.userPosition.fetch(address);
    expect(state.user.equals(otherUser.publicKey)).to.equal(true);
    expect(address.equals(position(main.vault, user.publicKey)[0])).to.equal(false);
  });

  it("allows independent positions for the same user in different vaults", async () => {
    await program.methods.openPosition().accountsStrict(openAccounts(second))
      .signers([user]).rpc();
    const address = position(second.vault, user.publicKey)[0];
    const state = await program.account.userPosition.fetch(address);
    expect(state.vault.equals(second.vault)).to.equal(true);
    expect(address.equals(position(main.vault, user.publicKey)[0])).to.equal(false);
  });

  for (const field of ["vault", "shareMint", "tokenVault"] as const) {
    it(`rejects a noncanonical ${field} during initialization atomically`, async () => {
      await rejects(() => program.methods.initializeVault().accountsStrict({
        ...initAccounts(fresh), [field]: Keypair.generate().publicKey,
      }).rpc(), /ConstraintSeeds/);
      for (const address of [fresh.vault, fresh.shareMint, fresh.tokenVault]) {
        expect(await provider.connection.getAccountInfo(address)).to.equal(null);
      }
    });
  }

  it("requires the administrator's signature on initialization", async () => {
    const ix = await program.methods.initializeVault().accountsStrict({
      ...initAccounts(fresh), administrator: otherUser.publicKey,
    }).instruction();
    await rejects(() => withoutSigner(ix, otherUser.publicKey), /AccountNotSigner/);
    expect(await provider.connection.getAccountInfo(fresh.vault)).to.equal(null);
  });

  it("rejects a non-token account supplied as the asset mint", async () => {
    const invalid = addresses(payer.publicKey);
    await rejects(() => program.methods.initializeVault().accountsStrict(initAccounts(invalid))
      .rpc(), /AccountOwnedByWrongProgram/);
  });

  it("rejects a substituted token program", async () => {
    await rejects(() => program.methods.initializeVault().accountsStrict({
      ...initAccounts(fresh), tokenProgram: SystemProgram.programId,
    }).rpc(), /InvalidProgramId/);
  });

  // Use a new signer for these failures so duplicate position checks cannot mask them.
  it("rejects another vault with the original asset mint", async () => {
    await rejects(() => program.methods.openPosition().accountsStrict({
      ...openAccounts(main, payer.publicKey), vault: second.vault,
      position: position(second.vault, payer.publicKey)[0],
    }).rpc(), /ConstraintSeeds/);
  });

  it("rejects a different asset mint for an existing vault", async () => {
    await rejects(() => program.methods.openPosition().accountsStrict({
      ...openAccounts(main, payer.publicKey), assetMint: second.assetMint,
    }).rpc(), /ConstraintSeeds/);
  });

  for (const field of ["shareMint", "tokenVault"] as const) {
    it(`rejects another vault's ${field}`, async () => {
      await rejects(() => program.methods.openPosition().accountsStrict({
        ...openAccounts(main, payer.publicKey), [field]: second[field],
      }).rpc(), /ConstraintHasOne|ConstraintSeeds/);
    });
  }

  it("rejects a same-mint token account controlled by an outsider", async () => {
    const outsiderAccount = await createAccount(provider.connection, payer, main.assetMint, payer.publicKey);
    await rejects(() => program.methods.openPosition().accountsStrict({
      ...openAccounts(main, payer.publicKey), tokenVault: outsiderAccount,
    }).rpc(), /ConstraintHasOne|ConstraintSeeds|ConstraintTokenOwner/);
  });

  it("rejects opening a position derived for a different user", async () => {
    await rejects(() => program.methods.openPosition().accountsStrict({
      ...openAccounts(second, otherUser.publicKey),
      position: position(second.vault, payer.publicKey)[0],
    }).signers([otherUser]).rpc(), /ConstraintSeeds/);
  });

  it("rejects opening a position derived for a different vault", async () => {
    await rejects(() => program.methods.openPosition().accountsStrict({
      ...openAccounts(main, payer.publicKey),
      position: position(second.vault, payer.publicKey)[0],
    }).rpc(), /ConstraintSeeds/);
  });

  it("requires the user's signature on open_position", async () => {
    const ix = await program.methods.openPosition()
      .accountsStrict(openAccounts(second, otherUser.publicKey)).instruction();
    await rejects(() => withoutSigner(ix, otherUser.publicKey), /AccountNotSigner/);
    expect(await provider.connection.getAccountInfo(position(second.vault, otherUser.publicKey)[0]))
      .to.equal(null);
  });

  it("leaves share supply and token balances at zero after opening positions", async () => {
    expect((await getMint(provider.connection, main.shareMint)).supply).to.equal(0n);
    expect((await getAccount(provider.connection, main.tokenVault)).amount).to.equal(0n);
    expect(await provider.connection.getAccountInfo(position(main.vault, payer.publicKey)[0]))
      .to.equal(null);
  });
});
