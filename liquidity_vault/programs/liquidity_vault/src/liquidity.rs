//! Vault-owned Token-2022 position NFT; underlying pool assets remain classic SPL.
use crate::{raydium, strategy, Strategy, VaultConfig, VaultError};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken},
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{Mint as NftMint, TokenAccount as NftToken},
};

#[account]
#[derive(InitSpace)]
pub struct LiquidityPosition {
    pub strategy: Pubkey,
    pub position: Pubkey,
    pub nft_mint: Pubkey,
    pub nft_account: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub deposited_a: u64,
    pub deposited_b: u64,
    pub withdrawn_a: u64,
    pub withdrawn_b: u64,
    pub fees_a: u64,
    pub fees_b: u64,
    pub rent_returned: u64,
    pub cycle: u64,
    pub open: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct LiquidityCore<'info> {
    #[account(mut)]
    pub administrator: Signer<'info>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = administrator, has_one = asset_mint, has_one = token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = administrator, has_one = pool, has_one = quote_mint,
        has_one = quote_vault, has_one = pool_asset_vault, has_one = pool_quote_vault)]
    pub strategy: Box<Account<'info, Strategy>>,
    #[account(mut, seeds = [b"token-vault", vault.key().as_ref()], bump = vault.token_vault_bump,
        token::mint = asset_mint, token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = vault,
        associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: stored pool and complete canonical pool/mint bindings checked before CPI.
    #[account(mut, owner = raydium::ID)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, token::mint = asset_mint, token::authority = pool)]
    pub pool_asset_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = pool)]
    pub pool_quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed executable, never a caller-selected CPI target.
    #[account(address = raydium::ID, executable)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct OpenLiquidityPosition<'info> {
    pub core: LiquidityCore<'info>,
    #[account(init_if_needed, payer = core.administrator, space = 8 + LiquidityPosition::INIT_SPACE,
        seeds = [b"liquidity", core.strategy.key().as_ref()], bump)]
    pub record: Box<Account<'info, LiquidityPosition>>,
    #[account(mut)]
    pub nft_mint: Signer<'info>,
    /// CHECK: canonical Token-2022 ATA, created by Raydium and verified after CPI.
    #[account(mut)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: canonical Raydium position PDA, verified before and after creation.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: canonical legacy protocol-position PDA; forwarded for ABI compatibility.
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: canonical tick array for the chosen lower tick; Raydium may initialize it.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: canonical tick array for the chosen upper tick; Raydium may initialize it.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: canonical bitmap, owner/discriminator/pool checked in handler.
    #[account(mut)]
    pub bitmap: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ManageLiquidity<'info> {
    pub core: LiquidityCore<'info>,
    #[account(mut, seeds = [b"liquidity", core.strategy.key().as_ref()], bump = record.bump,
        constraint = record.strategy == core.strategy.key())]
    pub record: Box<Account<'info, LiquidityPosition>>,
    /// CHECK: fixed NFT mint from the record, Token-2022 mint fields verified in handler.
    #[account(address = record.nft_mint)]
    pub nft_mint: UncheckedAccount<'info>,
    /// CHECK: stored canonical ATA; actual NFT amount/owner/delegate checked in handler.
    #[account(address = record.nft_account)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: stored canonical Raydium account, complete position fields checked in handler.
    #[account(mut, address = record.position, owner = raydium::ID)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: canonical legacy protocol-position PDA.
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: canonical tick array and pool link checked in handler.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: canonical tick array and pool link checked in handler.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: canonical bitmap and pool link checked in handler.
    #[account(mut)]
    pub bitmap: UncheckedAccount<'info>,
    /// CHECK: fixed executable Memo program required by DecreaseLiquidityV2.
    #[account(address = raydium::MEMO, executable)]
    pub memo_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseLiquidityPosition<'info> {
    pub administrator: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.asset_mint.as_ref()], bump = vault.bump, has_one = administrator)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = administrator, has_one = pool)]
    pub strategy: Box<Account<'info, Strategy>>,
    #[account(mut, seeds = [b"liquidity", strategy.key().as_ref()], bump = record.bump, has_one = strategy)]
    pub record: Box<Account<'info, LiquidityPosition>>,
    /// CHECK: stored mint, parsed and verified before CPI; must be closed afterwards.
    #[account(mut, address = record.nft_mint)]
    pub nft_mint: UncheckedAccount<'info>,
    /// CHECK: stored ATA, owner/amount/delegate verified before CPI; must be closed afterwards.
    #[account(mut, address = record.nft_account)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: stored canonical position and all obligations checked before CPI.
    #[account(mut, address = record.position, owner = raydium::ID)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: stored pool supplied to Raydium when NFT thaw is required.
    #[account(mut, owner = raydium::ID)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: fixed executable Raydium CLMM program.
    #[account(address = raydium::ID, executable)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(VaultError::ArithmeticOverflow))
}
fn delta(after: u64, before: u64) -> Result<u64> {
    after
        .checked_sub(before)
        .ok_or_else(|| error!(VaultError::InvalidSwapDelta))
}
pub(crate) fn range(lower: i32, upper: i32, spacing: u16) -> Result<()> {
    let s = i32::from(spacing);
    require!(
        s > 0
            && lower >= -443636
            && upper <= 443636
            && lower < upper
            && lower % s == 0
            && upper % s == 0,
        VaultError::InvalidPositionRange
    );
    Ok(())
}
fn lock(version: u8, active: bool, open: bool) -> Result<()> {
    strategy::require_active(version, active)?;
    require!(
        open && version == strategy::POSITION_VERSION,
        VaultError::InvalidLiquidityPosition
    );
    Ok(())
}
fn core(a: &LiquidityCore) -> Result<raydium::PoolView> {
    strategy::require_active(a.vault.version, a.strategy.active)?;
    let p = raydium::pool_state(&a.pool)?;
    require_keys_eq!(
        p.config,
        a.strategy.config,
        VaultError::InvalidRaydiumAccount
    );
    let is0 = p.mint0 == a.asset_mint.key();
    require!(
        (is0 && p.mint1 == a.quote_mint.key())
            || (!is0 && p.mint1 == a.asset_mint.key() && p.mint0 == a.quote_mint.key()),
        VaultError::InvalidRaydiumAccount
    );
    require_keys_eq!(
        if is0 { p.vault0 } else { p.vault1 },
        a.pool_asset_vault.key(),
        VaultError::InvalidRaydiumAccount
    );
    require_keys_eq!(
        if is0 { p.vault1 } else { p.vault0 },
        a.pool_quote_vault.key(),
        VaultError::InvalidRaydiumAccount
    );
    let data = a.pool.try_borrow_data()?;
    // This strategy admits reward-free pools only; never silently discard reward obligations.
    for i in 0..3 {
        require!(
            raydium::key(&data, 454 + i * 169)? == Pubkey::default(),
            VaultError::UnsupportedRewards
        );
    }
    Ok(p)
}
fn pda(info: &AccountInfo, seeds: &[&[u8]]) -> Result<()> {
    require_keys_eq!(
        info.key(),
        Pubkey::find_program_address(seeds, &raydium::ID).0,
        VaultError::InvalidLiquidityPosition
    );
    Ok(())
}
fn arrays<'info>(
    pool: Pubkey,
    lower: i32,
    upper: i32,
    spacing: u16,
    lo: &AccountInfo<'info>,
    hi: &AccountInfo<'info>,
    protocol: &AccountInfo,
    bitmap: &AccountInfo,
    creating: bool,
) -> Result<(i32, i32)> {
    range(lower, upper, spacing)?;
    let width = i32::from(spacing) * 60;
    let starts = (
        lower.div_euclid(width) * width,
        upper.div_euclid(width) * width,
    );
    pda(
        protocol,
        &[
            b"position",
            pool.as_ref(),
            &lower.to_le_bytes(),
            &upper.to_le_bytes(),
        ],
    )?;
    pda(
        bitmap,
        &[b"pool_tick_array_bitmap_extension", pool.as_ref()],
    )?;
    raydium::linked(bitmap, pool, "account:TickArrayBitmapExtension", 1832, 8)?;
    for (info, start) in [(lo, starts.0), (hi, starts.1)] {
        pda(info, &[b"tick_array", pool.as_ref(), &start.to_be_bytes()])?;
        require!(info.is_writable, VaultError::InvalidTickArray);
        if !creating || !info.data_is_empty() {
            raydium::linked(info, pool, "account:TickArrayState", 10240, 8)?;
            require!(
                i32::from_le_bytes(info.try_borrow_data()?[40..44].try_into().unwrap()) == start,
                VaultError::InvalidTickArray
            );
        }
    }
    Ok(starts)
}
struct PositionView {
    liquidity: u128,
    fees_a: u64,
    fees_b: u64,
    rewards: [u64; 3],
}
fn position(
    info: &AccountInfo,
    mint: Pubkey,
    pool: Pubkey,
    lower: i32,
    upper: i32,
) -> Result<PositionView> {
    raydium::check_header(info, "account:PersonalPositionState", 281)?;
    pda(info, &[b"position", mint.as_ref()])?;
    let d = info.try_borrow_data()?;
    require!(
        raydium::key(&d, 9)? == mint
            && raydium::key(&d, 41)? == pool
            && i32::from_le_bytes(d[73..77].try_into().unwrap()) == lower
            && i32::from_le_bytes(d[77..81].try_into().unwrap()) == upper,
        VaultError::InvalidLiquidityPosition
    );
    let u64_at = |n| u64::from_le_bytes(d[n..n + 8].try_into().unwrap());
    Ok(PositionView {
        liquidity: u128::from_le_bytes(d[81..97].try_into().unwrap()),
        fees_a: u64_at(129),
        fees_b: u64_at(137),
        rewards: [u64_at(161), u64_at(185), u64_at(209)],
    })
}
fn nft(mint: &AccountInfo, account: &AccountInfo, vault: Pubkey) -> Result<()> {
    let program = anchor_spl::token_2022::ID;
    require_keys_eq!(*mint.owner, program, VaultError::InvalidLiquidityPosition);
    require_keys_eq!(
        *account.owner,
        program,
        VaultError::InvalidLiquidityPosition
    );
    require_keys_eq!(
        account.key(),
        get_associated_token_address_with_program_id(&vault, mint.key, &program),
        VaultError::InvalidLiquidityPosition
    );
    let m = NftMint::try_deserialize(&mut &mint.try_borrow_data()?[..])?;
    let a = NftToken::try_deserialize(&mut &account.try_borrow_data()?[..])?;
    require!(
        m.supply == 1
            && m.decimals == 0
            && m.mint_authority.is_none()
            && a.mint == mint.key()
            && a.owner == vault
            && a.amount == 1
            && a.delegate.is_none()
            && a.close_authority.is_none(),
        VaultError::InvalidLiquidityPosition
    );
    Ok(())
}
fn invoke<'info>(
    program: AccountInfo<'info>,
    vault: &VaultConfig,
    data: Vec<u8>,
    accounts: Vec<(AccountInfo<'info>, bool, bool)>,
) -> Result<()> {
    let metas = accounts
        .iter()
        .map(|(a, w, s)| {
            if *w {
                AccountMeta::new(a.key(), *s)
            } else {
                AccountMeta::new_readonly(a.key(), *s)
            }
        })
        .collect();
    let mut infos: Vec<_> = accounts.into_iter().map(|(a, _, _)| a).collect();
    infos.push(program);
    invoke_signed(
        &Instruction {
            program_id: raydium::ID,
            accounts: metas,
            data,
        },
        &infos,
        &[&[b"vault", vault.asset_mint.as_ref(), &[vault.bump]]],
    )?;
    Ok(())
}
fn ordered<'info>(a: &LiquidityCore<'info>, is0: bool) -> [AccountInfo<'info>; 6] {
    let x = [
        a.token_vault.to_account_info(),
        a.quote_vault.to_account_info(),
        a.pool_asset_vault.to_account_info(),
        a.pool_quote_vault.to_account_info(),
        a.asset_mint.to_account_info(),
        a.quote_mint.to_account_info(),
    ];
    if is0 {
        x
    } else {
        [
            x[1].clone(),
            x[0].clone(),
            x[3].clone(),
            x[2].clone(),
            x[5].clone(),
            x[4].clone(),
        ]
    }
}
pub fn open(ctx: Context<OpenLiquidityPosition>, lower: i32, upper: i32) -> Result<()> {
    let a = ctx.accounts;
    let p = core(&a.core)?;
    require!(
        !a.record.open && a.core.vault.version == strategy::LOCKED_VERSION,
        VaultError::PositionStillOpen
    );
    require!(
        a.record.strategy == Pubkey::default() || a.record.strategy == a.core.strategy.key(),
        VaultError::InvalidLiquidityPosition
    );
    range(lower, upper, p.spacing)?;
    require!(
        p.tick >= lower && p.tick < upper,
        VaultError::InvalidPositionRange
    );
    require!(
        a.nft_mint.data_is_empty() && a.personal_position.data_is_empty(),
        VaultError::InvalidLiquidityPosition
    );
    let mint = a.nft_mint.key();
    pda(&a.personal_position, &[b"position", mint.as_ref()])?;
    require_keys_eq!(
        a.nft_account.key(),
        get_associated_token_address_with_program_id(
            &a.core.vault.key(),
            &mint,
            &anchor_spl::token_2022::ID
        ),
        VaultError::InvalidLiquidityPosition
    );
    let starts = arrays(
        a.core.pool.key(),
        lower,
        upper,
        p.spacing,
        &a.tick_array_lower,
        &a.tick_array_upper,
        &a.protocol_position,
        &a.bitmap,
        true,
    )?;
    let cycle = add(a.record.cycle, 1)?;
    let [t0, t1, v0, v1, m0, m1] = ordered(&a.core, p.mint0 == a.core.asset_mint.key());
    let mut data = raydium::discriminator("global:open_position_with_token22_nft").to_vec();
    for n in [lower, upper, starts.0, starts.1] {
        data.extend(n.to_le_bytes());
    }
    data.extend(0_u128.to_le_bytes());
    data.extend(0_u64.to_le_bytes());
    data.extend(0_u64.to_le_bytes());
    data.extend([0, 0]); // no metadata, Option<bool>::None: create empty position only
    invoke(
        a.core.raydium_program.to_account_info(),
        &a.core.vault,
        data,
        vec![
            (a.core.administrator.to_account_info(), true, true),
            (a.core.vault.to_account_info(), false, false),
            (a.nft_mint.to_account_info(), true, true),
            (a.nft_account.to_account_info(), true, false),
            (a.core.pool.to_account_info(), true, false),
            (a.protocol_position.to_account_info(), false, false),
            (a.tick_array_lower.to_account_info(), true, false),
            (a.tick_array_upper.to_account_info(), true, false),
            (a.personal_position.to_account_info(), true, false),
            (t0, true, false),
            (t1, true, false),
            (v0, true, false),
            (v1, true, false),
            (a.rent.to_account_info(), false, false),
            (a.system_program.to_account_info(), false, false),
            (a.core.token_program.to_account_info(), false, false),
            (a.associated_token_program.to_account_info(), false, false),
            (a.core.token_program_2022.to_account_info(), false, false),
            (m0, false, false),
            (m1, false, false),
            (a.bitmap.to_account_info(), true, false),
        ],
    )?;
    nft(&a.nft_mint, &a.nft_account, a.core.vault.key())?;
    require!(
        position(&a.personal_position, mint, a.core.pool.key(), lower, upper)?.liquidity == 0,
        VaultError::InvalidLiquidityPosition
    );
    let before = (a.core.token_vault.amount, a.core.quote_vault.amount);
    a.core.token_vault.reload()?;
    a.core.quote_vault.reload()?;
    require!(
        before == (a.core.token_vault.amount, a.core.quote_vault.amount),
        VaultError::InvalidSwapDelta
    );
    a.record.set_inner(LiquidityPosition {
        strategy: a.core.strategy.key(),
        position: a.personal_position.key(),
        nft_mint: mint,
        nft_account: a.nft_account.key(),
        tick_lower: lower,
        tick_upper: upper,
        liquidity: 0,
        deposited_a: 0,
        deposited_b: 0,
        withdrawn_a: 0,
        withdrawn_b: 0,
        fees_a: 0,
        fees_b: 0,
        rent_returned: 0,
        cycle,
        open: true,
        bump: ctx.bumps.record,
    });
    a.core.vault.version = strategy::POSITION_VERSION;
    a.core.strategy.recorded_quote_balance = a.core.quote_vault.amount;
    event(&a.record, 0, 0, 0);
    Ok(())
}
fn validate(a: &ManageLiquidity) -> Result<raydium::PoolView> {
    let p = core(&a.core)?;
    lock(a.core.vault.version, a.core.strategy.active, a.record.open)?;
    nft(&a.nft_mint, &a.nft_account, a.core.vault.key())?;
    let pos = position(
        &a.personal_position,
        a.record.nft_mint,
        a.core.pool.key(),
        a.record.tick_lower,
        a.record.tick_upper,
    )?;
    require!(
        pos.liquidity == a.record.liquidity,
        VaultError::InvalidLiquidityPosition
    );
    arrays(
        a.core.pool.key(),
        a.record.tick_lower,
        a.record.tick_upper,
        p.spacing,
        &a.tick_array_lower,
        &a.tick_array_upper,
        &a.protocol_position,
        &a.bitmap,
        false,
    )?;
    Ok(p)
}
fn change_cpi(
    a: &ManageLiquidity,
    p: &raydium::PoolView,
    increase: bool,
    amount: u128,
    limit_a: u64,
    limit_b: u64,
) -> Result<()> {
    let is0 = p.mint0 == a.core.asset_mint.key();
    let (l0, l1) = if is0 {
        (limit_a, limit_b)
    } else {
        (limit_b, limit_a)
    };
    let [t0, t1, v0, v1, m0, m1] = ordered(&a.core, is0);
    let mut data = raydium::discriminator(if increase {
        "global:increase_liquidity_v2"
    } else {
        "global:decrease_liquidity_v2"
    })
    .to_vec();
    data.extend(amount.to_le_bytes());
    data.extend(l0.to_le_bytes());
    data.extend(l1.to_le_bytes());
    let mut infos = vec![
        (a.core.vault.to_account_info(), false, true),
        (a.nft_account.to_account_info(), false, false),
    ];
    if increase {
        data.push(0); // Option<bool>::None, exact liquidity
        infos.extend([
            (a.core.pool.to_account_info(), true, false),
            (a.protocol_position.to_account_info(), false, false),
            (a.personal_position.to_account_info(), true, false),
            (a.tick_array_lower.to_account_info(), true, false),
            (a.tick_array_upper.to_account_info(), true, false),
            (t0, true, false),
            (t1, true, false),
            (v0, true, false),
            (v1, true, false),
            (a.core.token_program.to_account_info(), false, false),
            (a.core.token_program_2022.to_account_info(), false, false),
            (m0, false, false),
            (m1, false, false),
            (a.bitmap.to_account_info(), true, false),
        ]);
    } else {
        infos.extend([
            (a.personal_position.to_account_info(), true, false),
            (a.core.pool.to_account_info(), true, false),
            (a.protocol_position.to_account_info(), false, false),
            (v0, true, false),
            (v1, true, false),
            (a.tick_array_lower.to_account_info(), true, false),
            (a.tick_array_upper.to_account_info(), true, false),
            (t0, true, false),
            (t1, true, false),
            (a.core.token_program.to_account_info(), false, false),
            (a.core.token_program_2022.to_account_info(), false, false),
            (a.memo_program.to_account_info(), false, false),
            (m0, false, false),
            (m1, false, false),
            (a.bitmap.to_account_info(), true, false),
        ]);
    }
    invoke(
        a.core.raydium_program.to_account_info(),
        &a.core.vault,
        data,
        infos,
    )
}
fn after(a: &mut ManageLiquidity, expected: u128) -> Result<()> {
    let pos = position(
        &a.personal_position,
        a.record.nft_mint,
        a.core.pool.key(),
        a.record.tick_lower,
        a.record.tick_upper,
    )?;
    require!(
        pos.liquidity == expected,
        VaultError::InvalidLiquidityPosition
    );
    a.core.token_vault.reload()?;
    a.core.quote_vault.reload()?;
    a.record.liquidity = expected;
    a.core.strategy.recorded_quote_balance = a.core.quote_vault.amount;
    Ok(())
}
pub fn increase(ctx: Context<ManageLiquidity>, amount: u128, max_a: u64, max_b: u64) -> Result<()> {
    let a = ctx.accounts;
    let p = validate(a)?;
    require!(
        amount > 0 && amount <= i128::MAX as u128 && (max_a > 0 || max_b > 0),
        VaultError::InvalidLiquidityAmount
    );
    require!(
        a.core.token_vault.amount >= max_a && a.core.quote_vault.amount >= max_b,
        VaultError::InsufficientFunds
    );
    let expected = a
        .record
        .liquidity
        .checked_add(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let before = (a.core.token_vault.amount, a.core.quote_vault.amount);
    change_cpi(a, &p, true, amount, max_a, max_b)?;
    after(a, expected)?;
    let da = delta(before.0, a.core.token_vault.amount)?;
    let db = delta(before.1, a.core.quote_vault.amount)?;
    require!(
        da <= max_a && db <= max_b && (da > 0 || db > 0),
        VaultError::InvalidSwapDelta
    );
    a.record.deposited_a = add(a.record.deposited_a, da)?;
    a.record.deposited_b = add(a.record.deposited_b, db)?;
    event(&a.record, 1, da, db);
    Ok(())
}
fn collect_inner(
    a: &mut ManageLiquidity,
    p: &raydium::PoolView,
    min_a: u64,
    min_b: u64,
) -> Result<()> {
    let before = (a.core.token_vault.amount, a.core.quote_vault.amount);
    let liquidity = a.record.liquidity;
    change_cpi(a, p, false, 0, 0, 0)?;
    after(a, liquidity)?;
    let da = delta(a.core.token_vault.amount, before.0)?;
    let db = delta(a.core.quote_vault.amount, before.1)?;
    require!(da >= min_a && db >= min_b, VaultError::SlippageExceeded);
    let pos = position(
        &a.personal_position,
        a.record.nft_mint,
        a.core.pool.key(),
        a.record.tick_lower,
        a.record.tick_upper,
    )?;
    require!(
        pos.fees_a == 0 && pos.fees_b == 0 && pos.rewards == [0; 3],
        VaultError::UnsettledPosition
    );
    a.record.fees_a = add(a.record.fees_a, da)?;
    a.record.fees_b = add(a.record.fees_b, db)?;
    event(&a.record, 2, da, db);
    Ok(())
}
pub fn collect(ctx: Context<ManageLiquidity>, min_a: u64, min_b: u64) -> Result<()> {
    let a = ctx.accounts;
    let p = validate(a)?;
    collect_inner(a, &p, min_a, min_b)
}
pub fn decrease(ctx: Context<ManageLiquidity>, amount: u128, min_a: u64, min_b: u64) -> Result<()> {
    let a = ctx.accounts;
    let p = validate(a)?;
    require!(
        amount > 0
            && amount <= a.record.liquidity
            && amount <= i128::MAX as u128
            && (min_a > 0 || min_b > 0),
        VaultError::InvalidLiquidityAmount
    );
    // Separate fee income from principal, atomically, before burning any liquidity.
    collect_inner(a, &p, 0, 0)?;
    let before = (a.core.token_vault.amount, a.core.quote_vault.amount);
    let expected = a
        .record
        .liquidity
        .checked_sub(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    change_cpi(a, &p, false, amount, min_a, min_b)?;
    after(a, expected)?;
    let da = delta(a.core.token_vault.amount, before.0)?;
    let db = delta(a.core.quote_vault.amount, before.1)?;
    require!(da >= min_a && db >= min_b, VaultError::SlippageExceeded);
    a.record.withdrawn_a = add(a.record.withdrawn_a, da)?;
    a.record.withdrawn_b = add(a.record.withdrawn_b, db)?;
    event(&a.record, 3, da, db);
    Ok(())
}
pub fn close(ctx: Context<CloseLiquidityPosition>) -> Result<()> {
    let a = ctx.accounts;
    lock(a.vault.version, a.strategy.active, a.record.open)?;
    nft(&a.nft_mint, &a.nft_account, a.vault.key())?;
    let pos = position(
        &a.personal_position,
        a.record.nft_mint,
        a.pool.key(),
        a.record.tick_lower,
        a.record.tick_upper,
    )?;
    require!(
        a.record.liquidity == 0
            && pos.liquidity == 0
            && pos.fees_a == 0
            && pos.fees_b == 0
            && pos.rewards == [0; 3],
        VaultError::UnsettledPosition
    );
    let before = a.vault.to_account_info().lamports();
    invoke(
        a.raydium_program.to_account_info(),
        &a.vault,
        raydium::discriminator("global:close_position").to_vec(),
        vec![
            (a.vault.to_account_info(), true, true),
            (a.nft_mint.to_account_info(), true, false),
            (a.nft_account.to_account_info(), true, false),
            (a.personal_position.to_account_info(), true, false),
            (a.system_program.to_account_info(), false, false),
            (a.token_program_2022.to_account_info(), false, false),
            (a.pool.to_account_info(), true, false),
        ],
    )?;
    for info in [&a.personal_position, &a.nft_account, &a.nft_mint] {
        require!(
            info.lamports() == 0 && info.data_is_empty(),
            VaultError::UnsettledPosition
        );
    }
    a.record.rent_returned = add(
        a.record.rent_returned,
        delta(a.vault.to_account_info().lamports(), before)?,
    )?;
    a.record.open = false;
    a.vault.version = strategy::LOCKED_VERSION;
    event(&a.record, 4, 0, 0);
    Ok(())
}
#[event]
pub struct LiquidityEvent {
    pub strategy: Pubkey,
    pub position: Pubkey,
    pub operation: u8,
    pub liquidity: u128,
    pub amount_a: u64,
    pub amount_b: u64,
    pub fees_a: u64,
    pub fees_b: u64,
}
fn event(r: &LiquidityPosition, operation: u8, amount_a: u64, amount_b: u64) {
    emit!(LiquidityEvent {
        strategy: r.strategy,
        position: r.position,
        operation,
        liquidity: r.liquidity,
        amount_a,
        amount_b,
        fees_a: r.fees_a,
        fees_b: r.fees_b
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tick_ranges_are_aligned_ordered_and_bounded() {
        assert!(range(-660, 540, 60).is_ok());
        for (a, b, s) in [
            (-601, 600, 60),
            (600, -600, 60),
            (0, 0, 60),
            (-443700, 600, 60),
            (-600, 443700, 60),
            (-600, 600, 0),
        ] {
            assert!(range(a, b, s).is_err());
        }
    }
    #[test]
    fn position_lock_requires_all_three_state_components() {
        assert!(lock(0xc1, true, true).is_ok());
        for (v, a, o) in [
            (1, true, true),
            (0x81, true, true),
            (0xc1, false, true),
            (0xc1, true, false),
        ] {
            assert!(lock(v, a, o).is_err());
        }
        assert!(strategy::require_unlocked(0xc1).is_err());
    }
    #[test]
    fn fee_and_principal_counters_reject_overflow() {
        assert!(add(u64::MAX, 1).is_err());
        assert_eq!(add(u64::MAX - 1, 1).unwrap(), u64::MAX);
    }
    #[test]
    fn token_deltas_reject_wrong_direction() {
        assert!(delta(0, 1).is_err());
        assert_eq!(delta(u64::MAX, 0).unwrap(), u64::MAX);
    }
}
