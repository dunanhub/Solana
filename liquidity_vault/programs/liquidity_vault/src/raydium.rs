//! Minimal classic-token SwapV2 ABI, verified against Raydium CLMM and SDK v2.
//! No Raydium Anchor dependency: keep this program on Anchor 0.31.1.
use crate::VaultError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

pub const ID: Pubkey = Pubkey::from_str_const("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
pub const MEMO: Pubkey = Pubkey::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
pub const MIN_SQRT: u128 = 4_295_048_016;
pub const MAX_SQRT: u128 = 79_226_673_521_066_979_257_578_248_091;

pub fn discriminator(name: &str) -> [u8; 8] {
    hash(name.as_bytes()).to_bytes()[..8].try_into().unwrap()
}
fn key(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .and_then(|v| v.try_into().ok())
        .ok_or(VaultError::InvalidRaydiumAccount)?;
    Ok(Pubkey::new_from_array(bytes))
}
pub fn check_header(info: &AccountInfo, name: &str, size: usize) -> Result<()> {
    require_keys_eq!(*info.owner, ID, VaultError::InvalidRaydiumAccount);
    let data = info.try_borrow_data()?;
    require!(
        data.len() == size && data[..8] == discriminator(name),
        VaultError::InvalidRaydiumAccount
    );
    Ok(())
}
pub struct PoolView {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub mint0: Pubkey,
    pub mint1: Pubkey,
    pub vault0: Pubkey,
    pub vault1: Pubkey,
    pub observation: Pubkey,
    pub spacing: u16,
    pub liquidity: u128,
    pub sqrt_price: u128,
    pub tick: i32,
}
pub fn pool(info: &AccountInfo) -> Result<PoolView> {
    check_header(info, "account:PoolState", 1544)?;
    let d = info.try_borrow_data()?;
    let view = PoolView {
        config: key(&d, 9)?,
        creator: key(&d, 41)?,
        mint0: key(&d, 73)?,
        mint1: key(&d, 105)?,
        vault0: key(&d, 137)?,
        vault1: key(&d, 169)?,
        observation: key(&d, 201)?,
        spacing: u16::from_le_bytes(d[235..237].try_into().unwrap()),
        liquidity: u128::from_le_bytes(d[237..253].try_into().unwrap()),
        sqrt_price: u128::from_le_bytes(d[253..269].try_into().unwrap()),
        tick: i32::from_le_bytes(d[269..273].try_into().unwrap()),
    };
    require!(
        view.mint0 < view.mint1 && view.spacing > 0 && d[389] & 16 == 0,
        VaultError::InvalidRaydiumAccount
    );
    let expected = Pubkey::find_program_address(
        &[
            b"pool",
            view.config.as_ref(),
            view.mint0.as_ref(),
            view.mint1.as_ref(),
        ],
        &ID,
    )
    .0;
    require_keys_eq!(info.key(), expected, VaultError::InvalidRaydiumAccount);
    for (mint, vault) in [(view.mint0, view.vault0), (view.mint1, view.vault1)] {
        require_keys_eq!(
            vault,
            Pubkey::find_program_address(&[b"pool_vault", info.key.as_ref(), mint.as_ref()], &ID).0,
            VaultError::InvalidRaydiumAccount
        );
    }
    require_keys_eq!(
        view.observation,
        Pubkey::find_program_address(&[b"observation", info.key.as_ref()], &ID).0,
        VaultError::InvalidRaydiumAccount
    );
    Ok(view)
}
pub fn linked(
    info: &AccountInfo,
    pool: Pubkey,
    name: &str,
    size: usize,
    offset: usize,
) -> Result<()> {
    check_header(info, name, size)?;
    require_keys_eq!(
        key(&info.try_borrow_data()?, offset)?,
        pool,
        VaultError::InvalidRaydiumAccount
    );
    Ok(())
}
pub fn ticks(
    accounts: &[AccountInfo],
    pool: Pubkey,
    spacing: u16,
    tick: i32,
    zero_for_one: bool,
) -> Result<()> {
    require!(
        !accounts.is_empty() && accounts.len() <= 3,
        VaultError::InvalidTickArray
    );
    let width = i32::from(spacing)
        .checked_mul(60)
        .ok_or(VaultError::ArithmeticOverflow)?;
    require!(width > 0, VaultError::InvalidTickArray);
    let current_start = tick.div_euclid(width) * width;
    let mut previous = current_start;
    for (index, account) in accounts.iter().enumerate() {
        require!(
            account.is_writable && !account.is_signer,
            VaultError::InvalidTickArray
        );
        linked(account, pool, "account:TickArrayState", 10240, 8)?;
        let data = account.try_borrow_data()?;
        let start = i32::from_le_bytes(data[40..44].try_into().unwrap());
        require!(
            start % width == 0
                && if index == 0 {
                    start == current_start
                } else if zero_for_one {
                    start < previous
                } else {
                    start > previous
                },
            VaultError::InvalidTickArray
        );
        require_keys_eq!(
            account.key(),
            Pubkey::find_program_address(
                &[b"tick_array", pool.as_ref(), &start.to_be_bytes()],
                &ID
            )
            .0,
            VaultError::InvalidTickArray
        );
        previous = start;
    }
    Ok(())
}
pub fn check_price(current: u128, limit: u128, zero_for_one: bool) -> Result<()> {
    require!(
        limit > MIN_SQRT
            && limit < MAX_SQRT
            && if zero_for_one {
                limit < current
            } else {
                limit > current
            },
        VaultError::InvalidPriceLimit
    );
    Ok(())
}
pub fn swap_data(amount: u64, minimum: u64, limit: u128) -> Vec<u8> {
    let mut data = discriminator("global:swap_v2").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&minimum.to_le_bytes());
    data.extend_from_slice(&limit.to_le_bytes());
    data.push(1); // exact input
    data
}
