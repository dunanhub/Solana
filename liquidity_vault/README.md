# Liquidity Vault — Week 8: Vault Scaffold

**Владелец проекта: Бекзат Убниев.**

Учебный Solana-проект: основа хранилища SPL-токенов с отдельным mint долей и
позициями пользователей. В Week 8 реализовано только создание аккаунтов.
Переводы активов, выпуск долей, deposit и withdraw пока отсутствуют.

## Стек и сеть

- Rust, Anchor CLI / `anchor-lang` / `anchor-spl` **0.31.1**.
- Классическая программа SPL Token (`Tokenkeg…`), без Token-2022.
- TypeScript 5.7.3, `@coral-xyz/anchor` 0.31.1, `@solana/web3.js` 1.98.4.
- Node.js 20.19.0, Yarn 1.22.22; версии зависимостей закреплены lock-файлами.
- Целевая публичная сеть: **Devnet**. Автоматические тесты: **localnet**.

Использовано уже установленное окружение Ubuntu WSL: Rust 1.94.1 и Solana CLI
3.1.12. В [release notes Anchor 0.31.1](https://www.anchor-lang.com/docs/updates/release-notes/0-31-1)
рекомендован Solana 2.1.0; существующий CLI сохранён, чтобы не устанавливать
дублирующий toolchain. Результат проверки совместимости указан ниже.

`resolutions` закрепляет единственную версию `web3.js` для Anchor и тестов:
иначе Yarn устанавливает одновременно 1.98.4 и 1.99.0, чьи классы несовместимы
в TypeScript. Websocket-клиент также закреплён для воспроизводимости.
Features `token_2022` и `token_2022_extensions` у `anchor-spl` требуются макросам создания mint при компиляции;
runtime-типы `Account<Mint>`, `Account<TokenAccount>` и `Program<Token>`
по-прежнему допускают только классический SPL Token.

**Program ID:** `7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH`.
Это новый ключ данного проекта; один адрес указан для localnet и Devnet.

## Структура

```text
liquidity_vault/
├── Anchor.toml
├── Cargo.toml / Cargo.lock
├── package.json / yarn.lock
├── tsconfig.json
├── programs/liquidity_vault/
│   ├── Cargo.toml
│   └── src/lib.rs
├── scripts/prepare-local.sh
├── tests/liquidity_vault.ts
└── README.md
```

`target/` (бинарный файл, IDL, типы), `.anchor/` и `node_modules/` генерируются
локально и исключены из Git. Исходные проекты репозитория не изменяются.

## Аккаунты и PDA

Все PDA выводятся с Program ID Liquidity Vault и каноническим bump.

| Аккаунт | Seeds | Владелец аккаунта / назначение |
| --- | --- | --- |
| `VaultConfig` | `[b"vault", asset_mint]` | Liquidity Vault; одна конфигурация на mint |
| `ShareMint` | `[b"share-mint", vault]` | SPL Token; mint долей |
| `Token Vault` | `[b"token-vault", vault]` | SPL Token; хранилище базового актива |
| `UserPosition` | `[b"position", vault, user]` | Liquidity Vault; позиция пользователя в конкретном Vault |

`VaultConfig` содержит `administrator`, `asset_mint`, `share_mint`, `token_vault`,
три bump и `version = 1`. Размер с дискриминатором Anchor: **140 байт**.

`UserPosition` содержит `vault`, `user`, `shares = 0` и bump.
Размер с дискриминатором: **81 байт**. Счётчик долей пока не изменяется.

У ShareMint число decimals совпадает с базовым mint, mint authority — Vault PDA,
freeze authority отсутствует, начальный supply равен нулю. Token Vault имеет
базовый mint и token authority = Vault PDA; начальный баланс нулевой.
Это отдельный PDA token account, а не ATA. Владелец этих двух аккаунтов на уровне
Solana — программа SPL Token; её поле authority указывает на Vault PDA.

## Инструкции и модель доступа

### `initialize_vault`

Подписывающий `administrator` оплачивает rent и становится администратором.
Инструкция атомарно создаёт конфигурацию, ShareMint и Token Vault через Anchor
`init`. Все адреса проверяются seeds и bump; mint должен быть действительным
инициализированным mint классической программы SPL Token.

Создание Vault **открыто любому подписанту**: первым инициализировавший mint
становится администратором этого Vault. Подпись mint authority базового актива
не требуется. Задание не задаёт глобального администратора или allowlist;
приложению в следующих неделях потребуется проверять ожидаемого администратора
при выборе Vault. Администратор пока не имеет инструкций вывода или изменения
конфигурации. Повторный `initialize_vault` отклоняется, в том числе с другим
администратором.

### `open_position`

Пользователь подписывает транзакцию и оплачивает свою позицию. Проверяются
Vault PDA, сохранённый bump, привязки `has_one`, ShareMint, Token Vault и их
mint/authority. Позиция выводится одновременно из Vault и подписавшего пользователя.
Повторное открытие отклоняется: `init_if_needed` не используется.

Позиции разных пользователей и позиции одного пользователя в разных Vault
независимы. Операций чтения с ограничением доступа нет: данные Solana публичны;
защищается создание/изменение состояния от имени чужого пользователя.

Арифметики над балансами в Week 8 нет. Release-сборка включает
`overflow-checks`; checked arithmetic понадобится при расчётах Week 9–10.

## Ключи и подготовка WSL

Приватные ключи хранятся **вне репозитория**:

- `~/.config/solana/liquidity_vault/program-keypair.json` — ключ программы;
- `~/.config/solana/liquidity_vault/local-test-wallet.json` — только локальные тесты.

Ключ использованного Devnet-буфера также сохранён вне проекта:
`~/.config/solana/liquidity_vault/devnet-buffer-keypair.json`.
После успешного deploy буфер закрыт; его rent не остался заблокированным.

`prepare-local.sh` проверяет публичный адрес ключа программы, создаёт отдельный
локальный кошелёк при отсутствии и помещает в игнорируемый `target/deploy/`
символическую ссылку на внешний ключ. Содержимое ключей не копируется в проект.
Не добавляйте ссылку или `target/` в Git принудительно.

```bash
cd /mnt/d/MySelf/Projects/Solana/liquidity_vault
# Если Node/Yarn недоступны в неинтерактивной WSL-сессии:
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
bash scripts/prepare-local.sh
yarn install --frozen-lockfile
cargo fmt --check
anchor build
yarn typecheck
anchor test
git diff --check
git status --short
```

`anchor test` запускает локальный validator, разворачивает программу и выполняет
TypeScript-тесты. Нужны свободный порт 8899 и локальный ключ из `Anchor.toml`.
Тестовый набор дополнительно отклоняет RPC-адреса вне localhost.

После клонирования внешний ключ не появляется автоматически. Владелец может
восстановить его из своего защищённого хранилища. Для независимой копии создайте
собственный ключ **вне Git**, затем согласованно обновите `declare_id!`, обе секции
`[programs.*]`, ожидаемый адрес в `prepare-local.sh` и этот README.

## Devnet

Конфигурация по умолчанию использует localnet, поэтому обычный `anchor test`
не расходует тестовые SOL публичной сети. Для Devnet явно укажите сеть и свой
кошелёк вне репозитория:

```bash
solana balance --url devnet --keypair /absolute/path/to/devnet-wallet.json
anchor deploy --provider.cluster devnet \
  --provider.wallet /absolute/path/to/devnet-wallet.json \
  -- --max-len "$(stat -c %s target/deploy/liquidity_vault.so)"
solana program show 7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH --url devnet
```

Перед deploy выполните подготовку, сборку и тесты. Нужны достаточные **тестовые**
SOL для rent программы, буфера загрузки и комиссий. Параметр `--max-len`
выделяет память под текущий бинарник без двойного запаса; для будущего увеличения
программы потребуется расширение ProgramData и дополнительный rent.
Mainnet в проекте не используется.

### Подтверждённое развёртывание

**Devnet deploy выполнен 25 октября 2026 года**, транзакция имеет статус
**Finalized**, аккаунт программы — `executable: true`.

- [Программа в Solana Explorer](https://explorer.solana.com/address/7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH?cluster=devnet).
- [Транзакция развёртывания](https://explorer.solana.com/tx/3kWmQKaFsKNs9Dy7LA2V2qhcY6K5vbcggKJGUCsuS4si9jSUEbPvqCW2RU5uSntYFeBsLe9DTZ5izDd47hjYYtDZ?cluster=devnet).
- Slot: `514746238`; размер: **274528 байт**.
- Upgrade authority: `bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe`.
- ProgramData: `J5UyTo8E3xLcmttCxXYRNyTo48P3ZZDqzD28j7jTEopF`.
- Скачанный через `solana program dump` бинарник **побайтово совпал** с локальной
  сборкой (`cmp`); SHA-256 обоих файлов:
  `4856ba5afebb67a92d064d700f225d871374530b6b470f52f4fc9894b0460e4a`.

Faucet отклонил запрос airdrop. Развёртывание выполнено за существующие тестовые
SOL с `--max-len 274528`. Первую отправку через RPC остановили после длительных
ошибок `429`; затем загрузку успешно продолжили тем же буфером через стандартный
транспорт `solana program deploy`, ограничив `--max-sign-attempts 3`.
Буфер `AjAYGJk7P9HqSnVhNX29NDm6gyrxgVZB1NgieZfkacmj` после deploy отсутствует
в сети (`AccountNotFound`), что подтверждает его закрытие.

В Devnet опубликована программа. Тестовые mint, Vault и позиции создавались
только на локальном validator.

## Результаты проверки

Проверено **25 октября 2026 года** в Ubuntu WSL:

| Проверка | Результат |
| --- | --- |
| `cargo fmt --check` | PASS |
| `anchor build` | PASS; SBF, IDL и TypeScript-типы сгенерированы |
| `yarn typecheck` | PASS |
| `anchor test` | **24 passing (4s)**; полный запуск с локальным validator 3.1.12 |
| `git diff --check` | PASS; все 13 новых файлов отдельно проверены через `--no-index --check` |
| Devnet deploy | PASS; Finalized, бинарник совпадает, буфер закрыт |

Тесты проверяют инициализацию, PDA/bump/размеры, администратора, mint/authority,
позиции, повторное создание, отсутствие подписей, подмену Vault/mint/token account,
изоляцию пользователей и Vault, атомарный откат ошибочной инициализации.
Отрицательные сценарии проверяют конкретную ошибку Anchor, а не любой сбой RPC.
Таким образом, установленный Solana CLI 3.1.12 прошёл проверку совместимости
с этим проектом на Anchor 0.31.1 без замены toolchain.

Устранены две проблемы зависимостей: недостающие compile-time features
`anchor-spl` и две несовместимые версии классов `web3.js`.
Остаётся предупреждение из макроса Anchor об устаревшем `AccountInfo::realloc`;
оно не мешает сборке. Yarn сообщает о необязательном для этих сценариев
peer dependency `fastestsmallesttextencoderdecoder` в транзитивных SPL codecs.
Ошибок компиляции или тестов в итоговом прогоне нет.

## Дальнейшие недели — только план

- **Week 9:** `deposit`, перевод SPL-токенов в Vault, выпуск долей через PDA signer,
  определение формулы долей, checked arithmetic и тесты балансов/округления.
- **Week 10:** `withdraw`, сжигание долей, вывод активов и граничные случаи.
- **Week 11:** интеграция стратегии ликвидности и учёт активов по методичке.
- **Week 12:** дополнительные проверки безопасности и интеграция клиента.
- **Week 13:** итоговые сценарии, документация и демонстрация.

Пункты Week 11–13 — предварительный план: подробная методичка этих недель
не предоставлена. Их реализация не входит в текущую работу.
