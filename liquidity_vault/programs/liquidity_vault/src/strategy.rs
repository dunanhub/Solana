use crate::{raydium, VaultConfig, VaultError};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
};

pub const SCHEMA_VERSION: u8 = 1;
pub const LOCKED_VERSION: u8 = 0x81;

pub fn require_unlocked(version: u8) -> Result<()> {
    require!(version != LOCKED_VERSION, VaultError::StrategyActive);
    require!(version == SCHEMA_VERSION, VaultError::InvalidStrategyState);
    Ok(())
}
fn require_active(version: u8, active: bool) -> Result<()> {
    require!(active, VaultError::StrategyInactive);
    require!(version == LOCKED_VERSION, VaultError::InvalidStrategyState);
    Ok(())
}
fn require_settled(actual_quote: u64, recorded_quote: u64) -> Result<()> {
    require!(
        actual_quote == 0 && recorded_quote == 0,
        VaultError::UnsettledStrategy
    );
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Strategy {
    pub vault: Pubkey,
    pub administrator: Pubkey,
    pub pool: Pubkey,
    pub config: Pubkey,
    pub quote_mint: Pubkey,
    pub quote_vault: Pubkey,
    pub pool_asset_vault: Pubkey,
    pub pool_quote_vault: Pubkey,
    pub observation: Pubkey,
    /// Actual quote balance after the most recent strategy operation, including donations.
    pub recorded_quote_balance: u64,
    pub swap_count: u64,
    pub active: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeStrategy<'info> {
    #[account(mut)]
    pub administrator: Signer<'info>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = administrator, has_one = asset_mint, has_one = token_vault, has_one = share_mint)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(seeds = [b"token-vault", vault.key().as_ref()], bump = vault.token_vault_bump,
        token::mint = asset_mint, token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"share-mint", vault.key().as_ref()], bump = vault.share_mint_bump, mint::authority = vault)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = administrator, space = 8 + Strategy::INIT_SPACE,
        seeds = [b"strategy", vault.key().as_ref()], bump)]
    pub strategy: Box<Account<'info, Strategy>>,
    #[account(init_if_needed, payer = administrator, associated_token::mint = quote_mint,
        associated_token::authority = vault, associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed owner, discriminator, canonical pool PDA and token bindings checked in handler.
    #[account(owner = raydium::ID)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: only the actual executable Devnet CLMM program is accepted.
    #[account(address = raydium::ID, executable)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageStrategy<'info> {
    pub administrator: Signer<'info>,
    #[account(mut, seeds = [b"vault", vault.asset_mint.as_ref()], bump = vault.bump,
        has_one = administrator, has_one = token_vault, has_one = share_mint)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = administrator, has_one = quote_mint, has_one = quote_vault)]
    pub strategy: Box<Account<'info, Strategy>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(associated_token::mint = quote_mint, associated_token::authority = vault,
        associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"token-vault", vault.key().as_ref()], bump = vault.token_vault_bump,
        constraint = token_vault.mint == vault.asset_mint, token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [b"share-mint", vault.key().as_ref()], bump = vault.share_mint_bump, mint::authority = vault)]
    pub share_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct StrategySwap<'info> {
    pub administrator: Signer<'info>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = administrator, has_one = asset_mint, has_one = token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = administrator, has_one = pool, has_one = config,
        has_one = quote_mint, has_one = quote_vault, has_one = pool_asset_vault,
        has_one = pool_quote_vault, has_one = observation)]
    pub strategy: Box<Account<'info, Strategy>>,
    #[account(mut, seeds = [b"token-vault", vault.key().as_ref()], bump = vault.token_vault_bump,
        token::mint = asset_mint, token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = vault,
        associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: fixed program plus executable check; never chosen by the caller.
    #[account(address = raydium::ID, executable)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: stored pool address, owner and packed PoolState checked before CPI.
    #[account(mut, owner = raydium::ID)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: bound to the pool, discriminator and owner checked before CPI.
    #[account(owner = raydium::ID)]
    pub config: UncheckedAccount<'info>,
    #[account(mut, token::mint = asset_mint, token::authority = pool)]
    pub pool_asset_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = pool)]
    pub pool_quote_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: stored/canonical observation PDA, owner and pool link checked in handler.
    #[account(mut, owner = raydium::ID)]
    pub observation: UncheckedAccount<'info>,
    /// CHECK: canonical CLMM bitmap PDA and pool link checked before forwarding.
    #[account(mut, owner = raydium::ID, seeds = [b"pool_tick_array_bitmap_extension", pool.key().as_ref()],
        bump, seeds::program = raydium::ID)]
    pub bitmap: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    /// CHECK: the fixed executable Memo program required by SwapV2.
    #[account(address = raydium::MEMO, executable)]
    pub memo_program: UncheckedAccount<'info>,
}

pub fn initialize(ctx: Context<InitializeStrategy>) -> Result<()> {
    require_unlocked(ctx.accounts.vault.version)?;
    let p = raydium::pool(&ctx.accounts.pool)?;
    let asset = ctx.accounts.asset_mint.key();
    let quote = ctx.accounts.quote_mint.key();
    require!(
        asset != quote
            && ((p.mint0 == asset && p.mint1 == quote) || (p.mint1 == asset && p.mint0 == quote)),
        VaultError::InvalidRaydiumAccount
    );
    require_keys_eq!(
        p.creator,
        ctx.accounts.administrator.key(),
        VaultError::InvalidRaydiumAccount
    );
    require!(
        p.liquidity > 0
            && ctx.accounts.token_vault.amount > 0
            && ctx.accounts.share_mint.supply > 0,
        VaultError::InvalidVaultState
    );
    let (asset_vault, quote_vault) = if p.mint0 == asset {
        (p.vault0, p.vault1)
    } else {
        (p.vault1, p.vault0)
    };
    ctx.accounts.strategy.set_inner(Strategy {
        vault: ctx.accounts.vault.key(),
        administrator: ctx.accounts.administrator.key(),
        pool: ctx.accounts.pool.key(),
        config: p.config,
        quote_mint: quote,
        quote_vault: ctx.accounts.quote_vault.key(),
        pool_asset_vault: asset_vault,
        pool_quote_vault: quote_vault,
        observation: p.observation,
        recorded_quote_balance: ctx.accounts.quote_vault.amount,
        swap_count: 0,
        active: true,
        bump: ctx.bumps.strategy,
    });
    ctx.accounts.vault.version = LOCKED_VERSION;
    Ok(())
}
pub fn start(ctx: Context<ManageStrategy>) -> Result<()> {
    require_unlocked(ctx.accounts.vault.version)?;
    require!(
        !ctx.accounts.strategy.active,
        VaultError::InvalidStrategyState
    );
    require!(
        ctx.accounts.share_mint.supply > 0
            && (ctx.accounts.token_vault.amount > 0 || ctx.accounts.quote_vault.amount > 0),
        VaultError::InvalidVaultState
    );
    ctx.accounts.strategy.active = true;
    ctx.accounts.strategy.recorded_quote_balance = ctx.accounts.quote_vault.amount;
    ctx.accounts.vault.version = LOCKED_VERSION;
    Ok(())
}
pub fn end(ctx: Context<ManageStrategy>) -> Result<()> {
    require_active(ctx.accounts.vault.version, ctx.accounts.strategy.active)?;
    require_settled(
        ctx.accounts.quote_vault.amount,
        ctx.accounts.strategy.recorded_quote_balance,
    )?;
    require!(
        ctx.accounts.share_mint.supply == 0 || ctx.accounts.token_vault.amount > 0,
        VaultError::InvalidVaultState
    );
    ctx.accounts.strategy.active = false;
    ctx.accounts.vault.version = SCHEMA_VERSION;
    Ok(())
}

pub fn execute_swap<'info>(
    ctx: Context<'_, '_, '_, 'info, StrategySwap<'info>>,
    a_to_b: bool,
    amount: u64,
    minimum: u64,
    limit: u128,
) -> Result<()> {
    let a = ctx.accounts;
    require_active(a.vault.version, a.strategy.active)?;
    require!(amount > 0 && minimum > 0, VaultError::InvalidSwapAmount);
    let p = raydium::pool(&a.pool)?;
    require_keys_eq!(p.config, a.config.key(), VaultError::InvalidRaydiumAccount);
    require_keys_eq!(
        p.observation,
        a.observation.key(),
        VaultError::InvalidRaydiumAccount
    );
    let asset = a.asset_mint.key();
    let quote = a.quote_mint.key();
    require!(
        (p.mint0 == asset
            && p.mint1 == quote
            && p.vault0 == a.pool_asset_vault.key()
            && p.vault1 == a.pool_quote_vault.key())
            || (p.mint1 == asset
                && p.mint0 == quote
                && p.vault1 == a.pool_asset_vault.key()
                && p.vault0 == a.pool_quote_vault.key()),
        VaultError::InvalidRaydiumAccount
    );
    raydium::check_header(&a.config, "account:AmmConfig", 117)?;
    raydium::linked(
        &a.observation,
        a.pool.key(),
        "account:ObservationState",
        4483,
        19,
    )?;
    raydium::linked(
        &a.bitmap,
        a.pool.key(),
        "account:TickArrayBitmapExtension",
        1832,
        8,
    )?;
    let zero_for_one = if a_to_b {
        asset == p.mint0
    } else {
        quote == p.mint0
    };
    raydium::check_price(p.sqrt_price, limit, zero_for_one)?;
    raydium::ticks(
        ctx.remaining_accounts,
        a.pool.key(),
        p.spacing,
        p.tick,
        zero_for_one,
    )?;
    let before_a = a.token_vault.amount;
    let before_b = a.quote_vault.amount;
    let before_in = if a_to_b { before_a } else { before_b };
    let before_out = if a_to_b { before_b } else { before_a };
    require!(before_in >= amount, VaultError::InsufficientFunds);
    let next_count = a
        .strategy
        .swap_count
        .checked_add(1)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let (source, destination, pool_source, pool_destination, mint_in, mint_out) = if a_to_b {
        (
            a.token_vault.to_account_info(),
            a.quote_vault.to_account_info(),
            a.pool_asset_vault.to_account_info(),
            a.pool_quote_vault.to_account_info(),
            a.asset_mint.to_account_info(),
            a.quote_mint.to_account_info(),
        )
    } else {
        (
            a.quote_vault.to_account_info(),
            a.token_vault.to_account_info(),
            a.pool_quote_vault.to_account_info(),
            a.pool_asset_vault.to_account_info(),
            a.quote_mint.to_account_info(),
            a.asset_mint.to_account_info(),
        )
    };
    // Exact SwapSingleV2 account order. Only the Vault PDA is an inner signer.
    let mut infos = vec![
        a.vault.to_account_info(),
        a.config.to_account_info(),
        a.pool.to_account_info(),
        source,
        destination,
        pool_source,
        pool_destination,
        a.observation.to_account_info(),
        a.token_program.to_account_info(),
        a.token_program_2022.to_account_info(),
        a.memo_program.to_account_info(),
        mint_in,
        mint_out,
        a.bitmap.to_account_info(),
    ];
    let mut metas: Vec<AccountMeta> = infos
        .iter()
        .enumerate()
        .map(|(i, info)| {
            if matches!(i, 2..=7 | 13) {
                AccountMeta::new(info.key(), false)
            } else {
                AccountMeta::new_readonly(info.key(), i == 0)
            }
        })
        .collect();
    for tick in ctx.remaining_accounts {
        metas.push(AccountMeta::new(tick.key(), false));
        infos.push(tick.clone());
    }
    infos.push(a.raydium_program.to_account_info());
    let bump = [a.vault.bump];
    invoke_signed(
        &Instruction {
            program_id: raydium::ID,
            accounts: metas,
            data: raydium::swap_data(amount, minimum, limit),
        },
        &infos,
        &[&[b"vault", asset.as_ref(), &bump]],
    )?;
    a.token_vault.reload()?;
    a.quote_vault.reload()?;
    let (after_in, after_out) = if a_to_b {
        (a.token_vault.amount, a.quote_vault.amount)
    } else {
        (a.quote_vault.amount, a.token_vault.amount)
    };
    let spent = before_in
        .checked_sub(after_in)
        .ok_or(VaultError::InvalidSwapDelta)?;
    let received = after_out
        .checked_sub(before_out)
        .ok_or(VaultError::InvalidSwapDelta)?;
    require!(spent == amount, VaultError::PartialSwap);
    require!(
        received >= minimum && received > 0,
        VaultError::InvalidSwapDelta
    );
    a.strategy.recorded_quote_balance = a.quote_vault.amount;
    a.strategy.swap_count = next_count;
    emit!(StrategySwapEvent {
        vault: a.vault.key(),
        pool: a.pool.key(),
        a_to_b,
        spent,
        received,
        assets_after: a.token_vault.amount,
        quote_after: a.quote_vault.amount
    });
    Ok(())
}

#[event]
pub struct StrategySwapEvent {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub a_to_b: bool,
    pub spent: u64,
    pub received: u64,
    pub assets_after: u64,
    pub quote_after: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_schema_is_unlocked_but_active_bit_cannot_be_omitted() {
        assert!(require_unlocked(1).is_ok());
        assert!(require_unlocked(0x81).is_err());
        assert!(require_unlocked(0).is_err());
        assert!(require_unlocked(2).is_err());
    }
    #[test]
    fn strategy_and_vault_must_agree_on_active_state() {
        assert!(require_active(0x81, true).is_ok());
        assert!(require_active(1, true).is_err());
        assert!(require_active(0x81, false).is_err());
        assert!(require_active(1, false).is_err());
    }
    #[test]
    fn both_real_donations_and_recorded_obligations_prevent_unlock() {
        assert!(require_settled(0, 0).is_ok());
        assert!(require_settled(1, 0).is_err());
        assert!(require_settled(0, 1).is_err());
        assert!(require_settled(u64::MAX, u64::MAX).is_err());
    }
    #[test]
    fn limits_are_nonzero_bounded_and_directional() {
        let current = 1_u128 << 64;
        assert!(raydium::check_price(current, current - 1, true).is_ok());
        assert!(raydium::check_price(current, current + 1, false).is_ok());
        for limit in [0, raydium::MIN_SQRT, raydium::MAX_SQRT, current] {
            assert!(raydium::check_price(current, limit, true).is_err());
            assert!(raydium::check_price(current, limit, false).is_err());
        }
        assert!(raydium::check_price(current, current + 1, true).is_err());
        assert!(raydium::check_price(current, current - 1, false).is_err());
    }
    #[test]
    fn swap_v2_wire_layout_is_exact_input_little_endian() {
        let data = raydium::swap_data(42, 41, 1_u128 << 64);
        assert_eq!(data.len(), 41);
        assert_eq!(&data[..8], &[43, 4, 237, 11, 26, 201, 30, 98]);
        assert_eq!(u64::from_le_bytes(data[8..16].try_into().unwrap()), 42);
        assert_eq!(u64::from_le_bytes(data[16..24].try_into().unwrap()), 41);
        assert_eq!(
            u128::from_le_bytes(data[24..40].try_into().unwrap()),
            1_u128 << 64
        );
        assert_eq!(data[40], 1);
    }
}
