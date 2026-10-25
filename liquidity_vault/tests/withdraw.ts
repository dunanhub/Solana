import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import {
  approve, burn, closeAccount, createAccount, createMint, freezeAccount, getAccount,
  getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo,
  thawAccount, TOKEN_PROGRAM_ID, transferChecked,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("liquidity_vault — Week 10 withdrawals", () => {
  const environment = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new Connection(environment.connection.rpcEndpoint, "confirmed"), environment.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider.connection.rpcEndpoint).hostname)) {
    throw new Error("Integration tests require a local validator");
  }
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
    return { assetMint, vault,
      shareMint: pda([Buffer.from("share-mint"), vault.toBuffer()]),
      tokenVault: pda([Buffer.from("token-vault"), vault.toBuffer()]),
    };
  }
  type Fixture = ReturnType<typeof addresses>;
  type Accounts = ReturnType<typeof accounts>;
  let main: Fixture;
  let other: Fixture;

  function accounts(f: Fixture, user = alice.publicKey) {
    return { ...f, user,
      position: pda([Buffer.from("position"), f.vault.toBuffer(), user.toBuffer()]),
      userAssetAccount: getAssociatedTokenAddressSync(f.assetMint, user),
      userShareAccount: getAssociatedTokenAddressSync(f.shareMint, user),
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  function openPosition(f: Fixture, user: PublicKey) {
    return program.methods.openPosition().accountsStrict({ ...f, user,
      position: accounts(f, user).position, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });
  }

  async function fixture(initialBalance = 1_000n, openBob = true): Promise<Fixture> {
    const f = addresses(await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, decimals));
    await program.methods.initializeVault().accountsStrict({ ...f, administrator: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
    for (const user of [alice, bob]) {
      const a = accounts(f, user.publicKey);
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, f.assetMint, user.publicKey);
      await getOrCreateAssociatedTokenAccount(provider.connection, payer, f.shareMint, user.publicKey);
      if (user === alice || openBob) await openPosition(f, user.publicKey).signers([user]).rpc();
      if (initialBalance > 0n) await mintTo(provider.connection, payer, f.assetMint, a.userAssetAccount, payer, initialBalance);
    }
    return f;
  }

  function deposit(f: Fixture, user: Keypair, amount: bigint) {
    return program.methods.deposit(bn(amount), bn(amount)).accountsStrict(accounts(f, user.publicKey)).signers([user]).rpc();
  }

  function withdraw(f: Fixture, user: Keypair, shares: bigint, minimum: bigint, overrides: Partial<Accounts> = {}) {
    return program.methods.withdraw(bn(shares), bn(minimum))
      .accountsStrict({ ...accounts(f, user.publicKey), ...overrides }).signers([user]).rpc();
  }

  async function snapshot(f: Fixture, user = alice.publicKey, extra: PublicKey[] = []) {
    const a = accounts(f, user);
    const infos = await provider.connection.getMultipleAccountsInfo(
      [a.vault, a.tokenVault, a.shareMint, a.position, a.userAssetAccount, a.userShareAccount, ...extra], "confirmed",
    );
    return infos.map((info) => info && ({ owner: info.owner.toBase58(), data: info.data.toString("base64"), lamports: info.lamports }));
  }

  async function rejectsUnchanged(f: Fixture, action: () => Promise<unknown>, reason: RegExp,
    user = alice.publicKey, extra: PublicKey[] = []) {
    const before = await snapshot(f, user, extra);
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, "withdraw unexpectedly succeeded").not.to.equal(undefined);
    const error = caught as { logs?: string[]; message?: string };
    const text = [String(caught), error.message, ...(error.logs ?? [])].join("\n");
    expect(text).to.match(reason);
    expect(await snapshot(f, user, extra), "failed withdraw changed state").to.deep.equal(before);
    return text;
  }

  async function balances(f: Fixture, user = alice.publicKey) {
    const a = accounts(f, user);
    return {
      assets: (await getAccount(provider.connection, f.tokenVault)).amount,
      supply: (await getMint(provider.connection, f.shareMint)).supply,
      userAssets: (await getAccount(provider.connection, a.userAssetAccount)).amount,
      userShares: (await getAccount(provider.connection, a.userShareAccount)).amount,
      historicalShares: BigInt((await program.account.userPosition.fetch(a.position)).shares.toString()),
    };
  }

  before(async () => {
    await provider.sendAndConfirm(new Transaction().add(...[alice, bob].map((user) => SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: LAMPORTS_PER_SOL / 10,
    }))));
    main = await fixture();
    other = await fixture();
    await deposit(main, alice, 120n);
    await deposit(main, bob, 80n);
  });

  it("first withdrawal burns shares and credits assets while preserving history", async () => {
    await withdraw(main, alice, 20n, 20n);
    expect(await balances(main)).to.deep.equal({
      assets: 180n, supply: 180n, userAssets: 900n, userShares: 100n, historicalShares: 120n,
    });
  });

  it("supports a second partial withdrawal using the new pre-burn supply", async () => {
    await withdraw(main, alice, 30n, 30n);
    expect(await balances(main)).to.deep.equal({
      assets: 150n, supply: 150n, userAssets: 930n, userShares: 70n, historicalShares: 120n,
    });
  });

  it("lets another user redeem their entire balance without taking the other holder's assets", async () => {
    await withdraw(main, bob, 80n, 80n);
    expect(await balances(main, bob.publicKey)).to.deep.equal({
      assets: 70n, supply: 70n, userAssets: 1_000n, userShares: 0n, historicalShares: 80n,
    });
    expect((await balances(main)).userShares).to.equal(70n);
  });

  it("redeems all remaining supply and assets without closing accounts or changing UserPosition", async () => {
    const positionBefore = (await provider.connection.getAccountInfo(accounts(main).position))!.data;
    await withdraw(main, alice, 70n, 70n);
    expect(await balances(main)).to.deep.equal({
      assets: 0n, supply: 0n, userAssets: 1_000n, userShares: 0n, historicalShares: 120n,
    });
    expect((await provider.connection.getAccountInfo(accounts(main).position))!.data.equals(positionBefore)).to.equal(true);
  });

  it("rejects a repeated withdrawal after all shares have been burned", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n), /EmptyVault/);
  });

  it("accepts a new 1:1 deposit after complete redemption and keeps cumulative history", async () => {
    await deposit(main, alice, 10n);
    expect(await balances(main)).to.deep.equal({
      assets: 10n, supply: 10n, userAssets: 990n, userShares: 10n, historicalShares: 130n,
    });
  });

  it("rejects a zero burn", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 0n, 0n), /ZeroSharesToBurn/);
  });

  it("rejects an insufficient real share balance", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 11n, 0n), /InsufficientShares/);
  });

  it("does not treat historical deposits as withdrawal rights after shares were spent", async () => {
    await rejectsUnchanged(main, () => withdraw(main, bob, 1n, 0n), /InsufficientShares/, bob.publicKey);
    expect((await balances(main, bob.publicKey)).historicalShares).to.equal(80n);
  });

  it("rejects a u64::MAX burn above balance/supply without arithmetic wrap", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, maxU64, 0n), /InsufficientShares/);
  });

  it("rejects min_assets_out above the quote without burning", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 5n, 6n), /WithdrawSlippageExceeded/);
  });

  it("checks slippage even when redeeming all existing supply", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 10n, 11n), /WithdrawSlippageExceeded/);
  });

  for (const field of ["shareMint", "tokenVault"] as const) {
    it(`rejects another vault's ${field}`, async () => {
      await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { [field]: other[field] }),
        /ConstraintHasOne|ConstraintSeeds/, alice.publicKey, [other[field]]);
    });
  }

  it("rejects a different asset mint", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { assetMint: other.assetMint }), /ConstraintSeeds/);
  });

  it("rejects a different Vault PDA", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { vault: other.vault }), /ConstraintSeeds/);
  });

  it("rejects a Vault owned by another program", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { vault: payer.publicKey }), /AccountOwnedByWrongProgram/);
  });

  it("rejects an arbitrary same-mint token account as the Token Vault", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, {
      tokenVault: accounts(main, bob.publicKey).userAssetAccount,
    }), /ConstraintHasOne|ConstraintSeeds|ConstraintTokenOwner/);
  });

  it("rejects a position belonging to another user", async () => {
    const foreign = accounts(main, bob.publicKey).position;
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { position: foreign }),
      /ConstraintSeeds|ConstraintHasOne/, alice.publicKey, [foreign]);
  });

  it("rejects a position belonging to another vault", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { position: accounts(other).position }),
      /ConstraintSeeds|ConstraintHasOne/);
  });

  it("requires the user's signature", async () => {
    const ix = await program.methods.withdraw(bn(1n), bn(0n)).accountsStrict(accounts(main)).instruction();
    ix.keys.find((meta) => meta.pubkey.equals(alice.publicKey))!.isSigner = false;
    await rejectsUnchanged(main, () => provider.sendAndConfirm(new Transaction().add(ix)), /AccountNotSigner/);
  });

  it("rejects an arbitrary token program", async () => {
    await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { tokenProgram: SystemProgram.programId }), /InvalidProgramId/);
  });

  for (const field of ["userAssetAccount", "userShareAccount"] as const) {
    it(`rejects another user's ${field}`, async () => {
      const foreign = accounts(main, bob.publicKey)[field];
      await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { [field]: foreign }),
        /ConstraintAssociated|ConstraintTokenOwner/, alice.publicKey, [foreign]);
    });

    it(`rejects a wrong mint in ${field}`, async () => {
      await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { [field]: accounts(other)[field] }),
        /ConstraintAssociated|ConstraintTokenMint/);
    });

    it(`rejects a non-ATA ${field} despite matching mint and owner`, async () => {
      const mint = field === "userShareAccount" ? main.shareMint : main.assetMint;
      const arbitrary = await createAccount(provider.connection, payer, mint, alice.publicKey, Keypair.generate());
      await rejectsUnchanged(main, () => withdraw(main, alice, 1n, 0n, { [field]: arbitrary }),
        /ConstraintAssociated/, alice.publicKey, [arbitrary]);
    });
  }

  it("does not allow a delegate to burn another user's shares through withdraw", async () => {
    const source = accounts(main).userShareAccount;
    await approve(provider.connection, payer, source, bob.publicKey, alice, 10n);
    await rejectsUnchanged(main, () => withdraw(main, bob, 1n, 0n, { userShareAccount: source }),
      /ConstraintTokenOwner|ConstraintAssociated/, bob.publicKey, [source]);
  });

  it("rejects a missing asset ATA without burning shares", async () => {
    const f = await fixture();
    await deposit(f, alice, 1_000n);
    await closeAccount(provider.connection, payer, accounts(f).userAssetAccount, payer.publicKey, alice);
    await rejectsUnchanged(f, () => withdraw(f, alice, 1n, 0n), /AccountNotInitialized/);
  });

  it("rejects a missing share ATA", async () => {
    const f = await fixture();
    await deposit(f, alice, 10n);
    await transferChecked(provider.connection, payer, accounts(f).userShareAccount, f.shareMint,
      accounts(f, bob.publicKey).userShareAccount, alice, 10n, decimals);
    await closeAccount(provider.connection, payer, accounts(f).userShareAccount, payer.publicKey, alice);
    await rejectsUnchanged(f, () => withdraw(f, alice, 1n, 0n), /AccountNotInitialized/);
  });

  it("redeems transferred shares after opening a zero-history recipient position", async () => {
    const f = await fixture(1_000n, false);
    await deposit(f, alice, 100n);
    const a = accounts(f);
    const b = accounts(f, bob.publicKey);
    await transferChecked(provider.connection, payer, a.userShareAccount, f.shareMint, b.userShareAccount, alice, 40n, decimals);
    await rejectsUnchanged(f, () => withdraw(f, bob, 20n, 20n), /AccountNotInitialized/, bob.publicKey);
    // The recipient can compose the existing open_position and withdraw APIs atomically.
    await provider.sendAndConfirm(new Transaction().add(
      await openPosition(f, bob.publicKey).instruction(),
      await program.methods.withdraw(bn(20n), bn(20n)).accountsStrict(b).instruction(),
    ), [bob]);
    expect(await balances(f, bob.publicKey)).to.deep.equal({
      assets: 80n, supply: 80n, userAssets: 1_020n, userShares: 20n, historicalShares: 0n,
    });
    await withdraw(f, bob, 20n, 20n);
    await withdraw(f, alice, 60n, 60n);
    expect(await balances(f, bob.publicKey)).to.deep.equal({
      assets: 0n, supply: 0n, userAssets: 1_040n, userShares: 0n, historicalShares: 0n,
    });
    expect((await balances(f)).historicalShares).to.equal(100n);
  });

  it("floors partial output and returns all remaining rounding dust to the final holder", async () => {
    const f = await fixture();
    await deposit(f, alice, 6n);
    await transferChecked(provider.connection, payer, accounts(f).userAssetAccount, f.assetMint, f.tokenVault, alice, 4n, decimals);
    await withdraw(f, alice, 2n, 3n);
    expect(await balances(f)).to.deep.equal({
      assets: 7n, supply: 4n, userAssets: 993n, userShares: 4n, historicalShares: 6n,
    });
    await withdraw(f, alice, 4n, 7n);
    expect(await balances(f)).to.deep.equal({
      assets: 0n, supply: 0n, userAssets: 1_000n, userShares: 0n, historicalShares: 6n,
    });
  });

  it("only gives the final global supply holder the remainder, not any user's full balance", async () => {
    const f = await fixture();
    await deposit(f, alice, 3n);
    await deposit(f, bob, 3n);
    await transferChecked(provider.connection, payer, accounts(f).userAssetAccount, f.assetMint, f.tokenVault, alice, 1n, decimals);
    await withdraw(f, alice, 3n, 3n);
    expect((await balances(f)).assets).to.equal(4n);
    await withdraw(f, bob, 3n, 4n);
    expect((await balances(f, bob.publicKey)).userAssets).to.equal(1_001n);
    expect((await balances(f)).assets).to.equal(0n);
  });

  for (const field of ["tokenVault", "userAssetAccount"] as const) {
    it(`rejects a frozen ${field} after burn CPI succeeds in preflight, preserving all balances`, async () => {
      const f = await fixture();
      await deposit(f, alice, 10n);
      const frozen = accounts(f)[field];
      await freezeAccount(provider.connection, payer, frozen, f.assetMint, payer);
      const logs = await rejectsUnchanged(f, () => withdraw(f, alice, 5n, 5n), /frozen|0x11/i);
      expect(logs).to.include("Instruction: Burn");
      expect(logs).to.include("Instruction: TransferChecked");
      expect(logs.indexOf("Instruction: Burn")).to.be.lessThan(logs.indexOf("Instruction: TransferChecked"));
      await thawAccount(provider.connection, payer, frozen, f.assetMint, payer);
      await withdraw(f, alice, 5n, 5n);
      expect(await balances(f)).to.deep.equal({
        assets: 5n, supply: 5n, userAssets: 995n, userShares: 5n, historicalShares: 10n,
      });
    });
  }

  it("rejects withdrawal from an empty vault", async () => {
    const f = await fixture();
    await rejectsUnchanged(f, () => withdraw(f, alice, 1n, 0n), /EmptyVault/);
  });

  it("rejects assets with zero supply after all shares were externally burned", async () => {
    const f = await fixture();
    await deposit(f, alice, 10n);
    await burn(provider.connection, payer, accounts(f).userShareAccount, f.shareMint, alice, 10n);
    await rejectsUnchanged(f, () => withdraw(f, alice, 1n, 0n), /EmptyVault/);
    expect((await balances(f)).historicalShares).to.equal(10n);
  });

  it("uses the actual remaining share balance after an external partial burn", async () => {
    const f = await fixture();
    await deposit(f, alice, 10n);
    await burn(provider.connection, payer, accounts(f).userShareAccount, f.shareMint, alice, 4n);
    await rejectsUnchanged(f, () => withdraw(f, alice, 7n, 0n), /InsufficientShares/);
    await withdraw(f, alice, 6n, 10n);
    expect(await balances(f)).to.deep.equal({
      assets: 0n, supply: 0n, userAssets: 1_000n, userShares: 0n, historicalShares: 10n,
    });
  });

  it("prevents an outsider from burning the Vault's underlying assets", async () => {
    await rejectsUnchanged(main, () => burn(provider.connection, payer, main.tokenVault, main.assetMint, alice, 1n),
      /owner does not match|OwnerMismatch|0x4/i);
  });

  it("uses u128 for large partial withdrawals and can redeem u64::MAX in total", async () => {
    const f = await fixture(0n);
    await mintTo(provider.connection, payer, f.assetMint, accounts(f).userAssetAccount, payer, maxU64);
    await deposit(f, alice, maxU64);
    const half = 1n << 63n;
    await withdraw(f, alice, half, half);
    expect((await balances(f)).assets).to.equal(half - 1n);
    await withdraw(f, alice, half - 1n, half - 1n);
    expect(await balances(f)).to.deep.equal({
      assets: 0n, supply: 0n, userAssets: maxU64, userShares: 0n, historicalShares: maxU64,
    });
  });
});
