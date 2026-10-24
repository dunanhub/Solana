#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
key_dir="${HOME}/.config/solana/liquidity_vault"
program_key="${key_dir}/program-keypair.json"
expected_id="7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH"

if [[ ! -f "$program_key" ]]; then
  echo "Missing external program key: $program_key" >&2
  echo "Restore your key, or generate a new one outside the repository and update the Program ID." >&2
  exit 1
fi
if [[ "$(solana-keygen pubkey "$program_key")" != "$expected_id" ]]; then
  echo "Program key does not match the configured Program ID." >&2
  exit 1
fi

umask 077
if [[ ! -f "${key_dir}/local-test-wallet.json" ]]; then
  solana-keygen new --no-bip39-passphrase --silent \
    --outfile "${key_dir}/local-test-wallet.json"
fi
mkdir -p target/deploy
link="target/deploy/liquidity_vault-keypair.json"
if [[ -e "$link" || -L "$link" ]]; then
  if [[ ! -L "$link" || "$(readlink -f "$link")" != "$program_key" ]]; then
    echo "Refusing to replace existing program key or unexpected symlink: $link" >&2
    exit 1
  fi
else
  ln -s "$program_key" "$link"
fi
echo "External program key verified: $expected_id"
