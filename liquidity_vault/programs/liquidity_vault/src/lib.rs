use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked};

mod math;

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
    pub version: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub vault: Pubkey,
    pub user: Pubkey,
    /// Cumulative shares issued by deposits; external SPL transfers/burns do not update this field.
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
}
