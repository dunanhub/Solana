use anchor_lang::prelude::*;

declare_id!("9JHST1X1cSkdD4dS8gKppczjxJBs3Xv64N4MTgS3GxKQ");

#[program]
pub mod user_profile {
    use super::*;

    pub fn create_profile(
        ctx: Context<CreateProfile>,
        username: String,
        bio: String,
    ) -> Result<()> {
        require!(
            username.len() <= UserProfile::MAX_USERNAME_LEN,
            ProfileError::UsernameTooLong
        );
        require!(
            bio.len() <= UserProfile::MAX_BIO_LEN,
            ProfileError::BioTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.username = username;
        profile.bio = bio;
        profile.bump = ctx.bumps.profile;

        msg!("Profile created");
        Ok(())
    }

    pub fn update_profile(
        ctx: Context<UpdateProfile>,
        username: String,
        bio: String,
    ) -> Result<()> {
        require!(
            username.len() <= UserProfile::MAX_USERNAME_LEN,
            ProfileError::UsernameTooLong
        );
        require!(
            bio.len() <= UserProfile::MAX_BIO_LEN,
            ProfileError::BioTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.username = username;
        profile.bio = bio;

        msg!("Profile updated");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateProfile<'info> {
    #[account(
        init,
        payer = owner,
        space = UserProfile::SPACE,
        seeds = [b"profile", owner.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, UserProfile>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    #[account(
        mut,
        seeds = [b"profile", owner.key().as_ref()],
        bump = profile.bump,
        has_one = owner
    )]
    pub profile: Account<'info, UserProfile>,
    pub owner: Signer<'info>,
}

#[account]
pub struct UserProfile {
    pub owner: Pubkey,
    pub username: String,
    pub bio: String,
    pub bump: u8,
}

impl UserProfile {
    pub const MAX_USERNAME_LEN: usize = 32;
    pub const MAX_BIO_LEN: usize = 160;
    pub const SPACE: usize = 8 + 32 + (4 + Self::MAX_USERNAME_LEN) + (4 + Self::MAX_BIO_LEN) + 1;
}

#[error_code]
pub enum ProfileError {
    #[msg("Username must be at most 32 bytes")]
    UsernameTooLong,
    #[msg("Bio must be at most 160 bytes")]
    BioTooLong,
}
