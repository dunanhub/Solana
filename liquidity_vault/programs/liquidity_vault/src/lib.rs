use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, TransferChecked};

mod math;
mod raydium;
mod strategy;
pub use strategy::*;
mod liquidity;
pub use liquidity::*;

declare_id!("7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH");

#[program]
pub mod liquidity_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        ctx.accounts.vault.set_inner(VaultConfig {
            administrator: ctx.accounts.administrator.key(),
            asset_mint: ctx.accounts.asset_mint.key(),
            share_mint: ctx.accounts.share_mint.key(),
            token_vault: ctx.accounts.token_vault.key(),
            bump: ctx.bumps.vault,
            share_mint_bump: ctx.bumps.share_mint,
            token_vault_bump: ctx.bumps.token_vault,
            version: 1,
        });
        Ok(())
    }

    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        ctx.accounts.position.set_inner(UserPosition {
            vault: ctx.accounts.vault.key(),
            user: ctx.accounts.user.key(),
            shares: 0,
            bump: ctx.bumps.position,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
        strategy::require_unlocked(ctx.accounts.vault.version)?;
        // Snapshot the pre-deposit balance and supply, before either CPI.
        let quote = math::quote_deposit(
            amount,
            min_shares_out,
            ctx.accounts.token_vault.amount,
            ctx.accounts.share_mint.supply,
            ctx.accounts.position.shares,
        )?;
        require!(
            ctx.accounts.user_asset_account.amount >= amount,
            VaultError::InsufficientFunds
        );

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_asset_account.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        let asset_mint = ctx.accounts.asset_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let vault_seeds: &[&[u8]] = &[b"vault", asset_mint.as_ref(), &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            quote.shares_out,
        )?;

        ctx.accounts.position.shares = quote.position_shares_after;
        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        shares_to_burn: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        strategy::require_unlocked(ctx.accounts.vault.version)?;
        // Quote from the pre-burn supply and pre-transfer asset balance.
        // Historical position.shares is deliberately not an entitlement or a debit counter.
        let assets_out = math::quote_withdraw(
            shares_to_burn,
            min_assets_out,
            ctx.accounts.token_vault.amount,
            ctx.accounts.share_mint.supply,
            ctx.accounts.user_share_account.amount,
            ctx.accounts.user_asset_account.amount,
        )?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares_to_burn,
        )?;

        let asset_mint = ctx.accounts.asset_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let vault_seeds: &[&[u8]] = &[b"vault", asset_mint.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.user_asset_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            assets_out,
            ctx.accounts.asset_mint.decimals,
        )?;
        Ok(())
    }

    pub fn initialize_strategy(ctx: Context<InitializeStrategy>) -> Result<()> {
        strategy::initialize(ctx)
    }

    pub fn start_strategy(ctx: Context<ManageStrategy>) -> Result<()> {
        strategy::start(ctx)
    }

    pub fn swap<'info>(
        ctx: Context<'_, '_, '_, 'info, StrategySwap<'info>>,
        a_to_b: bool,
        amount: u64,
        min_amount_out: u64,
        sqrt_price_limit_x64: u128,
    ) -> Result<()> {
        strategy::execute_swap(ctx, a_to_b, amount, min_amount_out, sqrt_price_limit_x64)
    }

    pub fn end_strategy(ctx: Context<ManageStrategy>) -> Result<()> {
        strategy::end(ctx)
    }

    pub fn open_liquidity_position(
        ctx: Context<OpenLiquidityPosition>,
        lower: i32,
        upper: i32,
    ) -> Result<()> {
        liquidity::open(ctx, lower, upper)
    }
    pub fn increase_liquidity(
        ctx: Context<ManageLiquidity>,
        amount: u128,
        max_a: u64,
        max_b: u64,
    ) -> Result<()> {
        liquidity::increase(ctx, amount, max_a, max_b)
    }
    pub fn collect_fees(ctx: Context<ManageLiquidity>, min_a: u64, min_b: u64) -> Result<()> {
        liquidity::collect(ctx, min_a, min_b)
    }
    pub fn decrease_liquidity(
        ctx: Context<ManageLiquidity>,
        amount: u128,
        min_a: u64,
        min_b: u64,
    ) -> Result<()> {
        liquidity::decrease(ctx, amount, min_a, min_b)
    }
    pub fn close_liquidity_position(ctx: Context<CloseLiquidityPosition>) -> Result<()> {
        liquidity::close(ctx)
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// The first initializer of this asset's vault becomes its administrator.
    #[account(mut)]
    pub administrator: Signer<'info>,
    pub asset_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = administrator,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultConfig>,
    #[account(
        init,
        payer = administrator,
        seeds = [b"share-mint", vault.key().as_ref()],
        bump,
        mint::decimals = asset_mint.decimals,
        mint::authority = vault,
        mint::token_program = token_program
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = administrator,
        seeds = [b"token-vault", vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub asset_mint: Account<'info, Mint>,
    #[account(
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = share_mint,
        has_one = token_vault
    )]
    pub vault: Account<'info, VaultConfig>,
    #[account(
        seeds = [b"share-mint", vault.key().as_ref()],
        bump = vault.share_mint_bump,
        mint::authority = vault,
        mint::decimals = asset_mint.decimals,
        mint::token_program = token_program
    )]
    pub share_mint: Account<'info, Mint>,
    #[account(
        seeds = [b"token-vault", vault.key().as_ref()],
        bump = vault.token_vault_bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub token_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    // Keep account deserialization below SBF's 4 KiB stack-frame limit.
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = share_mint,
        has_one = token_vault
    )]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(
        mut,
        seeds = [b"share-mint", vault.key().as_ref()],
        bump = vault.share_mint_bump,
        mint::authority = vault,
        mint::decimals = asset_mint.decimals,
        mint::token_program = token_program
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [b"token-vault", vault.key().as_ref()],
        bump = vault.token_vault_bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = vault,
        has_one = user
    )]
    pub position: Box<Account<'info, UserPosition>>,
    // Both ATAs must already exist. Delegated spending is deliberately unsupported.
    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint,
        has_one = share_mint,
        has_one = token_vault
    )]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(
        mut,
        seeds = [b"share-mint", vault.key().as_ref()],
        bump = vault.share_mint_bump,
        mint::authority = vault,
        mint::decimals = asset_mint.decimals,
        mint::token_program = token_program
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [b"token-vault", vault.key().as_ref()],
        bump = vault.token_vault_bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    // A recipient of transferred shares can create this via open_position.
    // Read-only: cumulative deposit history must not be decremented by withdrawals.
    #[account(
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        has_one = vault,
        has_one = user
    )]
    pub position: Box<Account<'info, UserPosition>>,
    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub administrator: Pubkey,
    pub asset_mint: Pubkey,
    pub share_mint: Pubkey,
    pub token_vault: Pubkey,
    pub bump: u8,
    pub share_mint_bump: u8,
    pub token_vault_bump: u8,
    /// Low six bits: schema 1; 0x80 strategy lock; 0x40 open CLMM position lock.
    pub version: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub vault: Pubkey,
    pub user: Pubkey,
    /// Cumulative shares issued by deposits. Transfers, external burns and withdrawals do not debit it.
    pub shares: u64,
    pub bump: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount must be positive")]
    ZeroAmount,
    #[msg("Assets and share supply must either both be zero or both be positive")]
    InvalidVaultState,
    #[msg("Deposit would mint zero shares")]
    ZeroShares,
    #[msg("Calculated shares are below min_shares_out")]
    SlippageExceeded,
    #[msg("Token or position arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("User asset ATA has insufficient funds")]
    InsufficientFunds,
    #[msg("Shares to burn must be positive")]
    ZeroSharesToBurn,
    #[msg("Withdraw requires both positive assets and positive share supply")]
    EmptyVault,
    #[msg("Shares to burn exceed the user's balance or the total supply")]
    InsufficientShares,
    #[msg("Withdrawal would return zero assets")]
    ZeroAssetsOut,
    #[msg("Calculated assets are below min_assets_out")]
    WithdrawSlippageExceeded,
    #[msg("Vault deposits and withdrawals are locked by the active strategy")]
    StrategyActive,
    #[msg("Unsupported Vault version or inconsistent strategy lock")]
    InvalidStrategyState,
    #[msg("Strategy is not active")]
    StrategyInactive,
    #[msg("Invalid Raydium account, mint, pool or binding")]
    InvalidRaydiumAccount,
    #[msg("Invalid tick array, pool binding or directional ordering")]
    InvalidTickArray,
    #[msg("Swap amount and minimum output must both be positive")]
    InvalidSwapAmount,
    #[msg("Price limit must be bounded and in the swap direction")]
    InvalidPriceLimit,
    #[msg("Raydium must consume the full exact input amount")]
    PartialSwap,
    #[msg("Swap output or token balance delta is invalid")]
    InvalidSwapDelta,
    #[msg("Quote assets or recorded quote exposure remain unsettled")]
    UnsettledStrategy,
    #[msg("A Vault-owned CLMM position is still open")]
    PositionStillOpen,
    #[msg("Invalid liquidity position, NFT, authority or lifecycle state")]
    InvalidLiquidityPosition,
    #[msg("Invalid position tick range")]
    InvalidPositionRange,
    #[msg("Liquidity amount or token limits are invalid")]
    InvalidLiquidityAmount,
    #[msg("Rewards are not supported by this spot/liquidity strategy")]
    UnsupportedRewards,
    #[msg("Position liquidity, fees or rewards remain unsettled")]
    UnsettledPosition,
}
