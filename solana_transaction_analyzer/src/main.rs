use std::io::{self, Write};

const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

// struct groups the values that describe a transaction.
struct Transaction {
    amount_sol: f64,
    fee_sol: f64,
}

// enum represents the two possible validation outcomes.
enum TransactionStatus {
    Valid {
        amount_lamports: u64,
        fee_lamports: u64,
        total_lamports: u64,
    },
    Invalid(&'static str),
}

// Result lets the caller handle invalid input without a panic.
fn parse_number(input: &str) -> Result<f64, String> {
    input
        .trim()
        .parse::<f64>()
        .map_err(|_| "Please enter a number (for example, 3 or 0.00007993).".to_string())
}

fn read_number(prompt: &str) -> Result<f64, String> {
    println!("{prompt}");
    io::stdout()
        .flush()
        .map_err(|error| format!("Could not display the prompt: {error}"))?;

    let mut input = String::new(); // mutable: read_line fills this string.
    if io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("Could not read input: {error}"))?
        == 0
    {
        return Err("No input was provided.".to_string());
    }
    parse_number(&input)
}

fn sol_to_lamports(sol: f64) -> Result<u64, &'static str> {
    let lamports = sol * LAMPORTS_PER_SOL;
    if !lamports.is_finite() || lamports < 0.0 || lamports >= u64::MAX as f64 {
        return Err("SOL value is outside the supported range.");
    }
    Ok(lamports.round() as u64)
}

// Borrowing: the function reads a transaction without taking ownership of it.
fn validate_transaction(transaction: &Transaction) -> TransactionStatus {
    if !transaction.amount_sol.is_finite() || transaction.amount_sol <= 0.0 {
        return TransactionStatus::Invalid("Amount must be greater than 0 SOL.");
    }
    if !transaction.fee_sol.is_finite() || transaction.fee_sol < 0.0 {
        return TransactionStatus::Invalid("Fee cannot be negative.");
    }

    let Ok(amount_lamports) = sol_to_lamports(transaction.amount_sol) else {
        return TransactionStatus::Invalid("Amount is too large.");
    };
    let Ok(fee_lamports) = sol_to_lamports(transaction.fee_sol) else {
        return TransactionStatus::Invalid("Fee is too large.");
    };
    if amount_lamports == 0 {
        return TransactionStatus::Invalid("Amount is smaller than one lamport.");
    }
    let Some(total_lamports) = amount_lamports.checked_add(fee_lamports) else {
        return TransactionStatus::Invalid("Total is too large.");
    };

    TransactionStatus::Valid {
        amount_lamports,
        fee_lamports,
        total_lamports,
    }
}

// Borrowing: the caller can still use both values after this function returns.
fn print_summary(transaction: &Transaction, status: &TransactionStatus) {
    println!("\n--- Transaction Summary ---\n");
    println!("Amount: {} SOL", transaction.amount_sol);

    // match handles each enum variant explicitly.
    match status {
        TransactionStatus::Valid {
            amount_lamports,
            fee_lamports,
            total_lamports,
        } => {
            println!("Amount in lamports: {amount_lamports}");
            println!("Fee: {} SOL", transaction.fee_sol);
            println!("Fee in lamports: {fee_lamports}");
            println!("Total: {total_lamports} lamports");
            println!("Status: VALID");
        }
        TransactionStatus::Invalid(reason) => {
            println!("Fee: {} SOL", transaction.fee_sol);
            println!("Status: INVALID");
            println!("Reason: {reason}");
        }
    }
}

fn run() -> Result<(), String> {
    println!("=== Solana Transaction Analyzer ===");
    let amount_sol = read_number("Enter SOL amount:")?;
    let fee_sol = read_number("Enter transaction fee (SOL):")?;
    let transaction = Transaction {
        amount_sol,
        fee_sol,
    }; // immutable: the transaction is not changed after creation.
    let status = validate_transaction(&transaction);
    print_summary(&transaction, &status);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_three_sol_to_lamports() {
        assert_eq!(sol_to_lamports(3.0), Ok(3_000_000_000));
    }

    #[test]
    fn valid_transaction() {
        let transaction = Transaction {
            amount_sol: 3.0,
            fee_sol: 0.00007993,
        };
        assert!(matches!(
            validate_transaction(&transaction),
            TransactionStatus::Valid {
                amount_lamports: 3_000_000_000,
                fee_lamports: 79_930,
                total_lamports: 3_000_079_930
            }
        ));
    }

    #[test]
    fn zero_amount_is_invalid() {
        let transaction = Transaction {
            amount_sol: 0.0,
            fee_sol: 0.0,
        };
        assert!(matches!(
            validate_transaction(&transaction),
            TransactionStatus::Invalid(_)
        ));
    }

    #[test]
    fn negative_fee_is_invalid() {
        let transaction = Transaction {
            amount_sol: 3.0,
            fee_sol: -0.1,
        };
        assert!(matches!(
            validate_transaction(&transaction),
            TransactionStatus::Invalid(_)
        ));
    }

    #[test]
    fn text_input_returns_error() {
        assert!(parse_number("hello").is_err());
    }
}
