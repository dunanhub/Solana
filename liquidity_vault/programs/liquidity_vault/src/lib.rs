use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

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
    /// Zero in Week 8; share accounting will be implemented with deposits.
    pub shares: u64,
    pub bump: u8,
}
