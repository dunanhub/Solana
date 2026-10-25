use anchor_lang::prelude::*;

use crate::VaultError;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DepositQuote {
    pub shares_out: u64,
    pub position_shares_after: u64,
}

pub(crate) fn quote_deposit(
    amount: u64,
    min_shares_out: u64,
    total_assets: u64,
    total_shares: u64,
    position_shares: u64,
) -> Result<DepositQuote> {
    require!(amount > 0, VaultError::ZeroAmount);
    // Fail closed on donations to an empty vault or an inconsistent nonzero supply.
    require!(
        (total_assets == 0) == (total_shares == 0),
        VaultError::InvalidVaultState
    );
    let shares_out = if total_shares == 0 {
        amount
    } else {
        let quotient = u128::from(amount)
            .checked_mul(u128::from(total_shares))
            .and_then(|product| product.checked_div(u128::from(total_assets)))
            .ok_or(VaultError::ArithmeticOverflow)?;
        u64::try_from(quotient).map_err(|_| VaultError::ArithmeticOverflow)?
    };
    require!(shares_out > 0, VaultError::ZeroShares);
    require!(shares_out >= min_shares_out, VaultError::SlippageExceeded);

    // Check every affected u64 counter before moving tokens; SPL CPI also checks its counters.
    total_assets
        .checked_add(amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    total_shares
        .checked_add(shares_out)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let position_shares_after = position_shares
        .checked_add(shares_out)
        .ok_or(VaultError::ArithmeticOverflow)?;
    Ok(DepositQuote {
        shares_out,
        position_shares_after,
    })
}

pub(crate) fn quote_withdraw(
    shares_to_burn: u64,
    min_assets_out: u64,
    total_assets: u64,
    total_shares: u64,
    user_shares: u64,
    user_assets: u64,
) -> Result<u64> {
    require!(shares_to_burn > 0, VaultError::ZeroSharesToBurn);
    require!(total_assets > 0 && total_shares > 0, VaultError::EmptyVault);
    require!(
        shares_to_burn <= user_shares && shares_to_burn <= total_shares,
        VaultError::InsufficientShares
    );
    let assets_out = if shares_to_burn == total_shares {
        // The last holder receives all remaining dust; supply and assets become zero together.
        total_assets
    } else {
        let quotient = u128::from(shares_to_burn)
            .checked_mul(u128::from(total_assets))
            .and_then(|product| product.checked_div(u128::from(total_shares)))
            .ok_or(VaultError::ArithmeticOverflow)?;
        u64::try_from(quotient).map_err(|_| VaultError::ArithmeticOverflow)?
    };
    require!(assets_out > 0, VaultError::ZeroAssetsOut);
    require!(
        assets_out >= min_assets_out,
        VaultError::WithdrawSlippageExceeded
    );
    total_assets
        .checked_sub(assets_out)
        .ok_or(VaultError::ArithmeticOverflow)?;
    total_shares
        .checked_sub(shares_to_burn)
        .ok_or(VaultError::ArithmeticOverflow)?;
    user_shares
        .checked_sub(shares_to_burn)
        .ok_or(VaultError::ArithmeticOverflow)?;
    user_assets
        .checked_add(assets_out)
        .ok_or(VaultError::ArithmeticOverflow)?;
    Ok(assets_out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error(result: Result<DepositQuote>, expected: &str) {
        match result.unwrap_err() {
            Error::AnchorError(error) => assert_eq!(error.error_name, expected),
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn first_deposit_is_one_to_one_in_base_units() {
        assert_eq!(
            quote_deposit(1_000_000, 1_000_000, 0, 0, 0).unwrap(),
            DepositQuote {
                shares_out: 1_000_000,
                position_shares_after: 1_000_000,
            }
        );
    }

    #[test]
    fn proportional_deposit_rounds_down() {
        let quote = quote_deposit(5, 3, 3, 2, 9).unwrap();
        assert_eq!(quote.shares_out, 3);
        assert_eq!(quote.position_shares_after, 12);
    }

    #[test]
    fn multiplication_uses_u128_and_accepts_u64_boundary() {
        let half = 1_u64 << 63;
        let quote = quote_deposit(half - 1, half - 1, half, half, half).unwrap();
        assert_eq!(quote.shares_out, half - 1);
        assert_eq!(quote.position_shares_after, u64::MAX);
        assert_eq!(
            quote_deposit(u64::MAX, 0, 0, 0, 0).unwrap().shares_out,
            u64::MAX
        );
    }

    #[test]
    fn rejects_zero_amount_and_zero_output() {
        assert_error(quote_deposit(0, 0, 0, 0, 0), "ZeroAmount");
        assert_error(quote_deposit(1, 0, 100, 1, 0), "ZeroShares");
    }

    #[test]
    fn slippage_is_an_inclusive_lower_bound() {
        assert_eq!(quote_deposit(5, 3, 3, 2, 0).unwrap().shares_out, 3);
        assert_error(quote_deposit(5, 4, 3, 2, 0), "SlippageExceeded");
        assert_error(quote_deposit(1, 2, 0, 0, 0), "SlippageExceeded");
    }

    #[test]
    fn rejects_both_inconsistent_zero_states() {
        assert_error(quote_deposit(1, 0, 1, 0, 0), "InvalidVaultState");
        assert_error(quote_deposit(1, 0, 0, 1, 0), "InvalidVaultState");
    }

    #[test]
    fn rejects_share_result_exceeding_u64() {
        assert_error(quote_deposit(u64::MAX, 0, 1, 2, 0), "ArithmeticOverflow");
    }

    #[test]
    fn rejects_assets_supply_and_position_addition_overflow() {
        assert_error(
            quote_deposit(1, 0, u64::MAX, u64::MAX, 0),
            "ArithmeticOverflow",
        );
        assert_error(quote_deposit(1, 0, 1, u64::MAX, 0), "ArithmeticOverflow");
        assert_error(quote_deposit(1, 0, 1, 1, u64::MAX), "ArithmeticOverflow");
    }

    #[test]
    fn rounding_never_overcredits_shares_across_ratios() {
        for assets in 1_u64..32 {
            for supply in 1_u64..32 {
                for amount in 1_u64..32 {
                    if amount * supply < assets {
                        assert_error(quote_deposit(amount, 0, assets, supply, 0), "ZeroShares");
                    } else {
                        let shares = quote_deposit(amount, 0, assets, supply, 0)
                            .unwrap()
                            .shares_out;
                        assert!(shares * assets <= amount * supply);
                        assert!((shares + 1) * assets > amount * supply);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod withdraw_tests {
    use super::*;

    fn assert_error(result: Result<u64>, expected: &str) {
        match result.unwrap_err() {
            Error::AnchorError(error) => assert_eq!(error.error_name, expected),
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn proportional_partial_withdrawal_rounds_down() {
        assert_eq!(quote_withdraw(2, 3, 10, 6, 6, 0).unwrap(), 3);
    }

    #[test]
    fn final_holder_receives_all_remaining_assets_and_dust() {
        assert_eq!(quote_withdraw(4, 7, 7, 4, 4, 3).unwrap(), 7);
        assert_eq!(
            quote_withdraw(1, u64::MAX, u64::MAX, 1, 1, 0).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn zero_burn_is_rejected() {
        assert_error(quote_withdraw(0, 0, 1, 1, 1, 0), "ZeroSharesToBurn");
    }

    #[test]
    fn empty_assets_supply_and_both_empty_are_rejected() {
        for (assets, supply) in [(0, 1), (1, 0), (0, 0)] {
            assert_error(quote_withdraw(1, 0, assets, supply, 1, 0), "EmptyVault");
        }
    }

    #[test]
    fn actual_balance_and_supply_bound_the_burn() {
        assert_error(quote_withdraw(2, 0, 10, 10, 1, 0), "InsufficientShares");
        assert_error(
            quote_withdraw(2, 0, 10, 1, u64::MAX, 0),
            "InsufficientShares",
        );
        assert_error(
            quote_withdraw(u64::MAX, 0, 1, 1, u64::MAX, 0),
            "InsufficientShares",
        );
    }

    #[test]
    fn zero_output_never_burns_shares_even_with_zero_minimum() {
        assert_error(quote_withdraw(1, 0, 1, 2, 2, 0), "ZeroAssetsOut");
    }

    #[test]
    fn minimum_is_inclusive_for_partial_and_full_withdrawals() {
        assert_eq!(quote_withdraw(2, 3, 10, 6, 6, 0).unwrap(), 3);
        assert_error(
            quote_withdraw(2, 4, 10, 6, 6, 0),
            "WithdrawSlippageExceeded",
        );
        assert_error(
            quote_withdraw(6, 11, 10, 6, 6, 0),
            "WithdrawSlippageExceeded",
        );
    }

    #[test]
    fn u128_intermediate_handles_maximum_values_without_overflow() {
        let half = 1_u64 << 63;
        assert_eq!(
            quote_withdraw(half, half, u64::MAX, u64::MAX, u64::MAX, 0).unwrap(),
            half
        );
        assert_eq!(
            quote_withdraw(u64::MAX, 0, u64::MAX, u64::MAX, u64::MAX, 0).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn destination_addition_overflow_is_rejected() {
        assert_error(
            quote_withdraw(1, 0, 1, 1, 1, u64::MAX),
            "ArithmeticOverflow",
        );
    }

    #[test]
    fn rounding_and_final_redemption_conserve_assets_across_ratios() {
        for assets in 1_u64..32 {
            for supply in 1_u64..32 {
                for shares in 1..=supply {
                    if shares * assets < supply {
                        assert_error(
                            quote_withdraw(shares, 0, assets, supply, shares, 0),
                            "ZeroAssetsOut",
                        );
                    } else {
                        let out = quote_withdraw(shares, 0, assets, supply, shares, 0).unwrap();
                        assert!(out * supply <= shares * assets);
                        assert!((out + 1) * supply > shares * assets);
                        assert!(out <= assets);
                        if shares == supply {
                            assert_eq!(out, assets);
                        }
                    }
                }
            }
        }
    }
}
