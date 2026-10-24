import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  approve, burn, closeAccount, createAccount, createMint, freezeAccount,
  getAccount, getAssociatedTokenAddressSync, getMint,
  getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID, transferChecked,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { LiquidityVault } from "../target/types/liquidity_vault";
import { readFileSync } from "fs";
import { join } from "path";

describe("liquidity_vault — Week 9 deposits", () => {
  const environment = anchor.AnchorProvider.env();
  // Await the same commitment used by snapshots, so an older successful deposit
  // cannot become visible between the before/after reads of a rejected one.
  const provider = new anchor.AnchorProvider(
    new Connection(environment.connection.rpcEndpoint, "confirmed"), environment.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider.connection.rpcEndpoint).hostname)) {
    throw new Error("Integration tests require a local validator");
  }
  // Avoid Anchor's global workspace cache: Week 8 keeps its original provider.
  const idl: LiquidityVault = JSON.parse(readFileSync(join(__dirname, "../target/idl/liquidity_vault.json"), "utf8"));
  const program = new anchor.Program<LiquidityVault>(idl, provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const decimals = 6;
  const maxU64 = (1n << 64n) - 1n;
  const bn = (value: bigint) => new anchor.BN(value.toString());
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  function addresses(assetMint: PublicKey) {
    const vault = pda([Buffer.from("vault"), assetMint.toBuffer()]);
    const shareMint = pda([Buffer.from("share-mint"), vault.toBuffer()]);
    const tokenVault = pda([Buffer.from("token-vault"), vault.toBuffer()]);
    return { assetMint, vault, shareMint, tokenVault };
  }
  type Fixture = ReturnType<typeof addresses>;
  type DepositAccounts = ReturnType<typeof accounts>;
  let main: Fixture;
  let other: Fixture;

  function accounts(f: Fixture, user = alice.publicKey) {
    return {
      ...f, user,
      position: pda([Buffer.from("position"), f.vault.toBuffer(), user.toBuffer()]),
      userAssetAccount: getAssociatedTokenAddressSync(f.assetMint, user),
      userShareAccount: getAssociatedTokenAddressSync(f.shareMint, user),
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  async function fixture(initialBalance = 10_000n): Promise<Fixture> {
    const f = addresses(await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, decimals));
    await program.methods.initializeVault().accountsStrict({
      ...f, administrator: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    for (const user of [alice, bob]) {
      const a = accounts(f, user.publicKey);
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, f.assetMint, user.publicKey);
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, f.shareMint, user.publicKey);
      await program.methods.openPosition().accountsStrict({
        ...f, user: user.publicKey, position: a.position,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      if (initialBalance > 0n) {
        await mintTo(provider.connection, payer, f.assetMint, a.userAssetAccount, payer, initialBalance);
      }
    }
    return f;
  }

  function deposit(f: Fixture, user: Keypair, amount: bigint, minimum: bigint, overrides: Partial<DepositAccounts> = {}) {
    return program.methods.deposit(bn(amount), bn(minimum))
      .accountsStrict({ ...accounts(f, user.publicKey), ...overrides }).signers([user]).rpc();
  }

  async function snapshot(f: Fixture, user = alice.publicKey, extra: PublicKey[] = []) {
    const a = accounts(f, user);
    const keys = [a.vault, a.tokenVault, a.shareMint, a.position, a.userAssetAccount, a.userShareAccount, ...extra];
    const infos = await provider.connection.getMultipleAccountsInfo(keys, "confirmed");
    return infos.map((info) => info && ({
      owner: info.owner.toBase58(), data: info.data.toString("base64"), lamports: info.lamports,
    }));
  }

  async function rejectsUnchanged(
    f: Fixture, action: () => Promise<unknown>, reason: RegExp,
    user = alice.publicKey, extra: PublicKey[] = [],
  ) {
    const before = await snapshot(f, user, extra);
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, "transaction unexpectedly succeeded").not.to.equal(undefined);
    const error = caught as { logs?: string[]; message?: string };
    expect([String(caught), error.message, ...(error.logs ?? [])].join("\n")).to.match(reason);
    expect(await snapshot(f, user, extra), "failed deposit changed account state").to.deep.equal(before);
  }

  async function balances(f: Fixture, user = alice.publicKey) {
    const a = accounts(f, user);
    return {
      assets: (await getAccount(provider.connection, f.tokenVault)).amount,
      supply: (await getMint(provider.connection, f.shareMint)).supply,
      userAssets: (await getAccount(provider.connection, a.userAssetAccount)).amount,
      userShares: (await getAccount(provider.connection, a.userShareAccount)).amount,
      positionShares: BigInt((await program.account.userPosition.fetch(a.position)).shares.toString()),
    };
  }

  before(async () => {
    await provider.sendAndConfirm(new Transaction().add(...[alice, bob].map((user) => SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: LAMPORTS_PER_SOL / 10,
    }))));
    main = await fixture();
    other = await fixture();
  });

  it("first deposit transfers assets and mints 1:1 shares into the user's ATA", async () => {
    await deposit(main, alice, 100n, 100n);
    expect(await balances(main)).to.deep.equal({
      assets: 100n, supply: 100n, userAssets: 9_900n, userShares: 100n, positionShares: 100n,
    });
  });

  it("second deposit uses pre-deposit totals and accumulates the position", async () => {
    await deposit(main, alice, 50n, 50n);
    expect(await balances(main)).to.deep.equal({
      assets: 150n, supply: 150n, userAssets: 9_850n, userShares: 150n, positionShares: 150n,
    });
  });

  it("another user gets their own shares and position without changing Alice's position", async () => {
    await deposit(main, bob, 50n, 50n);
    expect(await balances(main, bob.publicKey)).to.deep.equal({
      assets: 200n, supply: 200n, userAssets: 9_950n, userShares: 50n, positionShares: 50n,
    });
    expect((await balances(main)).positionShares).to.equal(150n);
  });

  it("uses the actual vault balance after a donation and floors fractional shares", async () => {
    await transferChecked(provider.connection, payer, accounts(main).userAssetAccount,
      main.assetMint, main.tokenVault, alice, 100n, decimals);
    // Before deposit: 300 assets / 200 shares. floor(5 * 200 / 300) = 3.
    await deposit(main, alice, 5n, 3n);
    expect(await balances(main)).to.deep.equal({
      assets: 305n, supply: 203n, userAssets: 9_745n, userShares: 153n, positionShares: 153n,
    });
  });

  it("rejects zero amount without changing balances, supply or position", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 0n, 0n), /ZeroAmount/);
  });

  it("rejects a deposit rounded to zero even with min_shares_out = 0", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 1n, 0n), /ZeroShares/);
  });

  it("rejects slippage above the rounded quote atomically", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 4n), /SlippageExceeded/);
  });

  it("rejects an insufficient source balance atomically", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 20_000n, 0n), /InsufficientFunds/);
  });

  it("rejects arithmetic overflow before either token CPI", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, maxU64, 0n), /ArithmeticOverflow/);
  });

  it("rejects an asset mint from another vault", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { assetMint: other.assetMint }), /ConstraintSeeds/);
  });

  it("rejects a different Vault PDA", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { vault: other.vault }), /ConstraintSeeds/);
  });

  it("rejects a Vault account owned by another program", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { vault: payer.publicKey }), /AccountOwnedByWrongProgram/);
  });

  for (const field of ["shareMint", "tokenVault"] as const) {
    it(`rejects another vault's ${field}`, async () => {
      await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { [field]: other[field] }),
        /ConstraintHasOne|ConstraintSeeds/, alice.publicKey, [other[field]]);
    });
  }

  it("rejects an arbitrary same-mint account as the Token Vault", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, {
      tokenVault: accounts(main, bob.publicKey).userAssetAccount,
    }), /ConstraintHasOne|ConstraintSeeds|ConstraintTokenOwner/);
  });

  it("rejects another user's position", async () => {
    const foreign = accounts(main, bob.publicKey).position;
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { position: foreign }),
      /ConstraintSeeds|ConstraintHasOne/, alice.publicKey, [foreign]);
  });

  it("rejects the user's position from another vault", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { position: accounts(other).position }),
      /ConstraintSeeds|ConstraintHasOne/);
  });

  it("requires the user's signature", async () => {
    const ix = await program.methods.deposit(bn(5n), bn(0n)).accountsStrict(accounts(main)).instruction();
    ix.keys.find((meta) => meta.pubkey.equals(alice.publicKey))!.isSigner = false;
    await rejectsUnchanged(main, () => provider.sendAndConfirm(new Transaction().add(ix)), /AccountNotSigner/);
  });

  it("rejects a substituted token program", async () => {
    await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { tokenProgram: SystemProgram.programId }), /InvalidProgramId/);
  });

  for (const field of ["userAssetAccount", "userShareAccount"] as const) {
    it(`rejects a wrong mint in ${field}`, async () => {
      await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { [field]: accounts(other)[field] }),
        /ConstraintAssociated|ConstraintTokenMint/);
    });

    it(`rejects another user's ${field}`, async () => {
      const foreign = accounts(main, bob.publicKey)[field];
      await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { [field]: foreign }),
        /ConstraintTokenOwner|ConstraintAssociated/, alice.publicKey, [foreign]);
    });

    it(`rejects a non-ATA ${field} with otherwise correct mint and owner`, async () => {
      const mint = field === "userAssetAccount" ? main.assetMint : main.shareMint;
      const randomAccount = await createAccount(provider.connection, payer, mint, alice.publicKey, Keypair.generate());
      await rejectsUnchanged(main, () => deposit(main, alice, 5n, 0n, { [field]: randomAccount }),
        /ConstraintAssociated/, alice.publicKey, [randomAccount]);
    });
  }

  it("does not allow delegated spending even with sufficient allowance", async () => {
    const source = accounts(main).userAssetAccount;
    await approve(provider.connection, payer, source, bob.publicKey, alice, 1_000n);
    await rejectsUnchanged(main, () => deposit(main, bob, 5n, 0n, { userAssetAccount: source }),
      /ConstraintTokenOwner|ConstraintAssociated/, bob.publicKey, [source]);
  });

  for (const field of ["userAssetAccount", "userShareAccount"] as const) {
    it(`rejects a missing ${field} without implicitly creating it`, async () => {
      const f = await fixture(field === "userAssetAccount" ? 0n : 100n);
      await closeAccount(provider.connection, payer, accounts(f)[field], payer.publicKey, alice);
      await rejectsUnchanged(f, () => deposit(f, alice, 1n, 0n), /AccountNotInitialized/);
    });
  }

  it("propagates transfer_checked failure for a frozen asset ATA without minting shares", async () => {
    const f = await fixture(100n);
    await freezeAccount(provider.connection, payer, accounts(f).userAssetAccount, f.assetMint, payer);
    await rejectsUnchanged(f, () => deposit(f, alice, 10n, 10n), /frozen|0x11/i);
  });

  it("rolls back both successful token CPIs if a later transaction instruction fails", async () => {
    const before = await snapshot(main);
    const ix = await program.methods.deposit(bn(5n), bn(3n)).accountsStrict(accounts(main)).instruction();
    const latest = await provider.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(ix, SystemProgram.transfer({
      fromPubkey: alice.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 2 * LAMPORTS_PER_SOL,
    }));
    tx.sign(payer, alice);
    const signature = await provider.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    const confirmation = await provider.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    expect(confirmation.value.err).not.to.equal(null);
    const executed = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(executed).not.to.equal(null);
    const logs = executed!.meta!.logMessages!.join("\n");
    expect(logs).to.include("Instruction: TransferChecked");
    expect(logs).to.include("Instruction: MintTo");
    expect(logs).to.include(`Program ${program.programId.toBase58()} success`);
    expect(await snapshot(main)).to.deep.equal(before);
  });

  it("rejects donated assets with zero supply instead of assigning them to the next depositor", async () => {
    const f = await fixture(100n);
    await transferChecked(provider.connection, payer, accounts(f).userAssetAccount, f.assetMint, f.tokenVault, alice, 1n, decimals);
    await rejectsUnchanged(f, () => deposit(f, alice, 1n, 0n), /InvalidVaultState/);
  });

  it("rejects reinitializing the exchange rate after all shares are externally burned", async () => {
    const f = await fixture(100n);
    await deposit(f, alice, 10n, 10n);
    await burn(provider.connection, payer, accounts(f).userShareAccount, f.shareMint, alice, 10n);
    await rejectsUnchanged(f, () => deposit(f, alice, 1n, 0n), /InvalidVaultState/);
    expect((await balances(f)).positionShares).to.equal(10n);
  });

  it("reads actual supply after a partial external burn; position records issued shares", async () => {
    const f = await fixture(100n);
    await deposit(f, alice, 10n, 10n);
    await burn(provider.connection, payer, accounts(f).userShareAccount, f.shareMint, alice, 5n);
    await deposit(f, alice, 2n, 1n);
    expect(await balances(f)).to.deep.equal({
      assets: 12n, supply: 6n, userAssets: 88n, userShares: 6n, positionShares: 11n,
    });
  });

  it("supports a u128 intermediate and reaches u64::MAX without rounding or overflow", async () => {
    const f = await fixture(0n);
    await mintTo(provider.connection, payer, f.assetMint, accounts(f).userAssetAccount, payer, maxU64);
    const half = 1n << 63n;
    await deposit(f, alice, half, half);
    await deposit(f, alice, half - 1n, half - 1n);
    expect(await balances(f)).to.deep.equal({
      assets: maxU64, supply: maxU64, userAssets: 0n, userShares: maxU64, positionShares: maxU64,
    });
    await rejectsUnchanged(f, () => deposit(f, alice, 1n, 0n), /ArithmeticOverflow/);
  });
});
