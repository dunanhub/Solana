# Liquidity Vault — Week 10: Withdraw & Token CPI

**Владелец проекта: Бекзат Убниев.**

Учебный Solana-проект: основа хранилища SPL-токенов с отдельным mint долей и
позициями пользователей. Week 8 создаёт аккаунты; Week 9 добавляет внесение
активов и выпуск долей; Week 10 — вывод активов со сжиганием реальных shares.

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
│   └── src/{lib.rs,math.rs}
├── scripts/{prepare-local.sh,devnet-deposit.ts,devnet-withdraw.ts}
├── tests/{liquidity_vault.ts,deposit.ts,withdraw.ts}
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
Размер с дискриминатором: **81 байт**. В Week 9 `shares` увеличивается на число
долей, выпущенных этому пользователю через `deposit`. Схема аккаунтов, `version = 1`,
Program ID и все seeds сохранены: миграция аккаунтов Week 8 не нужна.

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
при выборе Vault. Администратор не имеет специальных инструкций вывода или изменения
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

Release-сборка включает `overflow-checks`, `lto = "fat"`, `codegen-units = 1`
и оптимизацию размера `opt-level = "s"`. Расчёты deposit/withdraw выполняются
через checked arithmetic; умножение и деление формул используют `u128`.

## Week 9 — `deposit(amount, min_shares_out)`

Параметры — `u64` в минимальных единицах, без floating-point. Для mint с шестью
decimals `1_000_000` означает один токен. Инструкция требует уже открытой позиции
и двух заранее созданных ATA пользователя — для базового актива и для shares.

```text
ATA актива пользователя ── transfer_checked(amount) ──> Token Vault
Vault PDA ── mint_to(shares_out), подпись PDA ──> ATA shares пользователя
UserPosition.shares += shares_out
```

Входные аккаунты: `user` (Signer), `asset_mint`, `vault`, `share_mint`,
`token_vault`, `position`, `user_asset_account`, `user_share_account`,
классическая программа SPL Token. Anchor проверяет владельцев аккаунтов,
seeds/bump, связи `has_one`, mint/authority и канонические адреса обеих ATA.
Подменить Token Vault произвольным token account или зачислить shares чужому
пользователю нельзя. Сам `deposit` не создаёт ATA и не открывает позицию.

### Формула и порядок действий

`total_assets` — фактический баланс Token Vault **до CPI**, `total_shares` —
фактический supply ShareMint **до CPI**:

```text
assets = 0 и supply = 0: shares_out = amount
assets > 0 и supply > 0: shares_out = floor(amount * supply / assets)
```

Пример: первый депозит 100 единиц даёт 100 shares. Следующий депозит 50 при
100 assets / 100 shares даёт 50 shares. Если в Vault 300 assets / 200 shares,
депозит 5 даёт `floor(5 * 200 / 300) = 3` shares. `min_shares_out = 3` допускает
его, а `min_shares_out = 4` отклоняет до перевода активов.

Сначала проверяются сумма, согласованность состояния, округлённый результат,
slippage, сложение всех счётчиков `u64` и баланс источника. Затем выполняется
`transfer_checked` с decimals базового mint и подписью владельца ATA.
После него `mint_to` выпускает доли **сразу в ATA пользователя**, используя
signer seeds `[b"vault", asset_mint, bump]`. Позиция обновляется после обоих CPI.
Любая ошибка откатывает всю транзакцию; отдельного выпуска shares без депозита нет.

### Ошибки и политика несогласованного состояния

| Ситуация | Результат |
| --- | --- |
| `amount = 0` | `ZeroAmount` |
| Только одно из `assets/supply` равно нулю | `InvalidVaultState` |
| Округление дало 0 shares | `ZeroShares`, даже при `min_shares_out = 0` |
| Shares меньше минимального выхода | `SlippageExceeded` |
| Результат не помещается в `u64` или переполняется счётчик | `ArithmeticOverflow` |
| Баланс ATA меньше суммы | `InsufficientFunds` |
| Нет ATA/позиции, неверные mint/PDA/owner, нет подписи | Ошибка соответствующего Anchor constraint |
| Базовый token account заморожен | Ошибка SPL Token CPI, без выпуска shares |

Оба несогласованных состояния **отклоняются**. При `assets > 0, supply = 0`
первый вкладчик не получает чужие активы бесплатно. При `assets = 0, supply > 0`
программа не создаёт доли по неопределённому курсу и не делит на ноль.

Следствие строгой политики: donation до первого депозита либо сжигание всех
shares при оставшихся активах блокирует дальнейшие депозиты этого Vault.
В Week 9 нет административного сброса, rescue или присвоения оставшихся активов.
Donation в работающий Vault учитывается в цене shares; остаток от округления
остаётся в Vault. Клиенту следует задавать осмысленный `min_shares_out`.

### Ограничения учёта

- Только классический SPL Token: Token-2022 и transfer fees не поддерживаются.
- Источник принадлежит подписанту и является его ATA. Делегированные депозиты
  не поддерживаются, поэтому allowance не используется; чужой ATA отклоняется
  даже при достаточном разрешении delegate.
- `UserPosition.shares` — накопительное число shares, выпущенных депозитами.
  Обычные SPL-переводы и внешнее сжигание shares не меняют этот счётчик. Он не
  является текущим балансом ATA или самостоятельным правом на вывод. Withdraw
  сжигает реальные shares владельца и оставляет этот исторический счётчик неизменным.
- Состояние `assets = 0, supply > 0` не создаётся доступными инструкциями Week 8–10;
  защитная ветка проверяется Rust unit-тестом без добавления тестового backdoor.
- Формула сохраняет заданное поведение первого депозита 1:1; virtual shares,
  стратегии ликвидности в текущую реализацию не входят.

## Week 10 — `withdraw(shares_to_burn, min_assets_out)`

Оба параметра — `u64` в минимальных единицах. До обоих CPI считываются баланс
Token Vault (`total_assets`) и supply ShareMint (`total_shares`):

```text
assets_out = floor(shares_to_burn * total_assets / total_shares)
shares_to_burn == total_shares: assets_out = total_assets

ATA shares пользователя ── burn(shares_to_burn), подпись пользователя ──> уменьшение supply
Token Vault ── transfer_checked(assets_out), подпись Vault PDA ──> ATA актива пользователя
UserPosition остаётся неизменным
```

Умножение и деление выполняются checked-операциями в `u128`, результат безопасно
преобразуется в `u64`. До burn проверяются баланс shares, supply, минимальный выход,
вычитания из балансов и сложение с балансом получателя. Floating-point отсутствует.
Успешный burn обязателен: только после него вызывается `transfer_checked` с decimals
базового mint. Signer seeds `[b"vault", asset_mint, bump]` позволяют программе
подписать перевод от имени Vault PDA; приватного ключа у PDA нет.

Пример округления: при 10 assets / 6 shares вывод 2 shares возвращает
`floor(20 / 6) = 3` assets. Остаются 7 assets / 4 shares; вывод последних 4 shares
возвращает все 7 assets. Полный баланс отдельного пользователя не означает полный
supply: при 7 assets и двух держателях по 3 shares первый получает 3, последний — 4.
После погашения всего supply оба значения равны нулю; аккаунты не закрываются,
новый депозит снова выпускает shares 1:1.

### Аккаунты, права и UserPosition

Набор входных аккаунтов совпадает с `deposit`. Проверяются подпись пользователя,
owner конфигурации и позиции, PDA и сохранённые bump, все `has_one`, mint authority
ShareMint, mint/authority Token Vault, канонические ATA пользователя и фиксированная
классическая Token Program. Произвольный token account, чужой получатель и delegate
не допускаются. Пользователь заранее создаёт обе ATA и открывает позицию.

Layout `UserPosition` (81 байт) и `VaultConfig` (140 байт), discriminator, version,
Program ID и seeds не изменены. Семантика полей позиции:

| Поле | Значение |
| --- | --- |
| `vault` | Vault, к которому принадлежит позиция |
| `user` | Владелец позиции и подписант |
| `shares` | Сумма shares, когда-либо выпущенных этому пользователю через `deposit` |
| `bump` | Сохранённый bump PDA позиции |

`shares` не является количеством внесённых базовых токенов, балансом ATA или
лимитом вывода. Withdraw получает позицию **только для чтения** и не уменьшает
историю. Поэтому у получателя переведённых shares нет underflow при нулевой истории.
Накопительная история по-прежнему ограничена `u64`; её переполнение при новом
депозите отклоняется существующим `ArithmeticOverflow`.

Если A передал shares пользователю B, B создаёт свои ATA и `open_position`, затем
вызывает withdraw с собственной подписью. `open_position` и withdraw можно включить
в одну транзакцию: это проверено на validator. История B остаётся нулевой, но реальный
burn даёт право на активы. Внешний SPL burn уменьшает реальный supply и права
сжигавшего; историческая позиция не позволяет повторно получить активы.

### Ошибки и границы модели

| Ситуация | Результат |
| --- | --- |
| `shares_to_burn = 0` | `ZeroSharesToBurn` (6006) |
| Assets или supply равны нулю | `EmptyVault` (6007) |
| Burn больше баланса пользователя или supply | `InsufficientShares` (6008) |
| Округлённый выход равен нулю | `ZeroAssetsOut` (6009), даже если minimum = 0 |
| Выход ниже `min_assets_out` | `WithdrawSlippageExceeded` (6010), включая полный вывод |
| Переполнение арифметики | Существующий `ArithmeticOverflow` (6004) |
| Подмена mint/ATA/PDA/owner/Token Program, неверная позиция или подпись | Ошибка constraint / проверки подписи |
| Заморожен источник или получатель активов | Ошибка второго CPI; вся транзакция отклоняется |

`min_assets_out` — включительная нижняя граница, проверяемая до burn. Нулевой
minimum отключает только ограничение slippage, но не проверку положительного выхода.
Если все shares сожжены внешней SPL-инструкцией, активы без supply не присваиваются:
deposit и withdraw отклоняются; rescue и административного обхода нет.

При доступных инструкциях отношение assets/supply начинается с 1 и не уменьшается
ниже 1. Поэтому положительный supply при нулевых assets, нулевой округлённый выход
и переполнение суммы двух корректных балансов одного mint проверяются чистыми
Rust-тестами без изменения validator-аккаунтов или добавления backdoor. Реальная
граница `u64::MAX` и промежуточное произведение в `u128` проверены также на validator.
Freeze authority базового mint может остановить переводы; Token-2022, комиссии,
стратегии, virtual shares и защита первого вкладчика от donation здесь не добавлены.

## Ключи и подготовка WSL

Ключи программы и рабочих кошельков хранятся **вне репозитория**:

- `~/.config/solana/liquidity_vault/program-keypair.json` — ключ программы;
- `~/.config/solana/liquidity_vault/local-test-wallet.json` — только локальные тесты.

Ключ использованного Devnet-буфера также сохранён вне проекта:
`~/.config/solana/liquidity_vault/devnet-buffer-keypair.json`.
После успешного deploy буфер закрыт; его rent не остался заблокированным.
Локальный validator генерирует одноразовые ключи в игнорируемом test-ledger;
после проверки этот временный ledger удаляется.

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
cargo test
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
solana program deploy target/deploy/liquidity_vault.so --url devnet \
  --keypair /absolute/path/to/devnet-wallet.json \
  --upgrade-authority /absolute/path/to/devnet-wallet.json \
  --program-id 7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH \
  --buffer "$HOME/.config/solana/liquidity_vault/devnet-buffer-keypair.json" \
  --max-len "$(stat -c %s target/deploy/liquidity_vault.so)" \
  --max-sign-attempts 3 --with-compute-unit-price 0
solana program show 7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH --url devnet
```

Перед deploy выполните подготовку, сборку и тесты. Нужны достаточные **тестовые**
SOL для rent программы, буфера загрузки и комиссий. Параметр `--max-len`
выделяет память под текущий бинарник без двойного запаса; для будущего увеличения
программы потребуется расширение ProgramData и дополнительный rent.
Mainnet в проекте не используется.
Команда использует существующий внешний ключ буфера. Если его нет в новом
окружении, создайте отдельный `solana-keygen` keypair вне репозитория. При
прерванной загрузке сначала проверьте программу и буфер; не создавайте новый
буфер, не разобравшись с предыдущим. Solana CLI 3.1.12 автоматически расширяет
ProgramData при необходимости; `--max-sign-attempts 3` ограничивает повторы.

### История: подтверждённое развёртывание Week 8

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

В Week 8 в Devnet была опубликована только программа; тестовые mint, Vault и
позиции того этапа создавались на локальном validator.

### Devnet-сценарий Week 9

После upgrade и проверки бинарника:

```bash
export ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json"
yarn devnet:deposit
```

`scripts/devnet-deposit.ts` использует фиксированный Devnet RPC и отдельный
тестовый mint с шестью decimals. Он создаёт Vault, две ATA и позицию, выпускает
2 тестовых токена в ATA пользователя, затем вносит **1 токен** с
`min_shares_out = 1_000_000`. Адреса, подписи и снимки балансов сохраняются в
`~/.config/solana/liquidity_vault/week9-smoke/receipts.json`; ключ тестового mint
лежит рядом, вне Git, с правами `0600`. Кошелёк внутри репозитория отклоняется.

Каждая подписанная транзакция записывается в журнал **до единственной отправки**.
При повторном запуске сценарий проверяет сохранённые подписи и не создаёт новые
транзакции для выполненных этапов. Неоднозначный ответ RPC не приводит к повторному
депозиту: выполняется только проверка статуса. Есть ограниченные повторы чтения
при 429 и ограниченное ожидание финализации. При неизвестном статусе сценарий
останавливается; повторный запуск продолжает проверять ту же подпись.
Не удаляйте журнал ради повторной отправки операции с неизвестным результатом.

### История: подтверждённый upgrade и депозит Week 9

**25 октября 2026 года** обновлена та же программа, без смены Program ID, seeds
или upgrade authority. Upgrade финализирован в slot **514751148**. ProgramData
расширен с 274528 до **330448 байт** и сохранил адрес
`J5UyTo8E3xLcmttCxXYRNyTo48P3ZZDqzD28j7jTEopF`.

Публичный бинарник скачан через `solana program dump` и побайтово сравнен с
локальной протестированной сборкой. SHA-256 обоих файлов:
`930e9016373267c65b6af2652c2bcabe0d1492a7b5c234305c8f27e49a42b8d7`.
Использован существующий баланс тестовых SOL; новый airdrop не потребовался.
Буфер `AjAYGJk7P9HqSnVhNX29NDm6gyrxgVZB1NgieZfkacmj` после upgrade закрыт.

Все приведённые транзакции имеют статус **Finalized**:

| Операция | Подпись / Solana Explorer (Devnet) |
| --- | --- |
| Upgrade Week 9 | [Wo53sfmMsqvfrWvY1agg6hxU6svgEd4He7FuvTk7U2Cy9qw5WKJVwWse2ESn3zVRedGAnSdT59HPRiqJs6xneAt](https://explorer.solana.com/tx/Wo53sfmMsqvfrWvY1agg6hxU6svgEd4He7FuvTk7U2Cy9qw5WKJVwWse2ESn3zVRedGAnSdT59HPRiqJs6xneAt?cluster=devnet) |
| Создание тестового mint | [2Gh4jUPeF1vRjqznVby7Un5esonNSUZYJtnvfkfV6YG1e16QzL9PLESE5yqghxwbffzoY9PfQtJpZCbUCrrwZ3mG](https://explorer.solana.com/tx/2Gh4jUPeF1vRjqznVby7Un5esonNSUZYJtnvfkfV6YG1e16QzL9PLESE5yqghxwbffzoY9PfQtJpZCbUCrrwZ3mG?cluster=devnet) |
| `initialize_vault` | [3XX68x4vfSjrXe3jZvB4Vc2xMKAavo6vJgJWbsdgGfwbUnNj4o9nvurd28UV1KSXEsVVwcQ3SsbXZoMdayERPt6m](https://explorer.solana.com/tx/3XX68x4vfSjrXe3jZvB4Vc2xMKAavo6vJgJWbsdgGfwbUnNj4o9nvurd28UV1KSXEsVVwcQ3SsbXZoMdayERPt6m?cluster=devnet) |
| ATA, позиция и выпуск тестовых активов | [d3GnGkpH3szDRfVuUcj9T2KTguanuwStycsrCqRiC4N4aUWbZmatbmc5Ny2LpH9dW4oPAnCyqSv7TSEiHAMZ1fE](https://explorer.solana.com/tx/d3GnGkpH3szDRfVuUcj9T2KTguanuwStycsrCqRiC4N4aUWbZmatbmc5Ny2LpH9dW4oPAnCyqSv7TSEiHAMZ1fE?cluster=devnet) |
| `deposit(1000000, 1000000)` | [5kzZsFa6F9FiEP7gUfotz1wdXbu3ZXcF218Xsu7otNQgWCKJcfBJuodbhQFbZmWrH9KCnairvGpm9iLtEDqfEWPE](https://explorer.solana.com/tx/5kzZsFa6F9FiEP7gUfotz1wdXbu3ZXcF218Xsu7otNQgWCKJcfBJuodbhQFbZmWrH9KCnairvGpm9iLtEDqfEWPE?cluster=devnet) |

Депозит выполнен в slot **514751420**. Тестовые адреса:

| Аккаунт | Адрес |
| --- | --- |
| Asset mint | [97EfbGqcFVi2MsVtfcGcDYdxzfBaGUx5H6YzCMtbfe5S](https://explorer.solana.com/address/97EfbGqcFVi2MsVtfcGcDYdxzfBaGUx5H6YzCMtbfe5S?cluster=devnet) |
| VaultConfig | `7jpsMqQMRwMJS9mmVHiXWAL5jCR1iJ8SfLya1YprMCEA` |
| ShareMint | [FK3fggzxrdzEow6tsUs8LUMR6YXgzBL4bRFopeJzBEtE](https://explorer.solana.com/address/FK3fggzxrdzEow6tsUs8LUMR6YXgzBL4bRFopeJzBEtE?cluster=devnet) |
| Token Vault | `3rRZQFXJZcyFinsPcn4aYdJaC7FCoD2UMdmrrzPF5pom` |
| UserPosition | `6jtnv8sconTzJapKGFv4FMGfCs73pFnDay3xmNkVCqm5` |
| ATA актива пользователя | `BKFDKZTEdkh2fhU6QyvkJoHRbvCK6MPFN8zvHhxNCp35` |
| ATA shares пользователя | `6737maPxu8QLVGpzPq2F2HyZy1pWWtF9bBRcWNMaXnji` |

Результат в минимальных единицах (6 decimals), прочитан с commitment `finalized`:

| Значение | До | После |
| --- | ---: | ---: |
| Активы в ATA пользователя | 2 000 000 | 1 000 000 |
| Активы Token Vault | 0 | 1 000 000 |
| Supply ShareMint | 0 | 1 000 000 |
| Shares в ATA пользователя | 0 | 1 000 000 |
| `UserPosition.shares` | 0 | 1 000 000 |

Повторный запуск сценария проверил те же четыре подписи без новых отправок.
Журнал и балансы не изменились; SHA-256 журнала до и после повторного запуска:
`655ae0141f60954e9604e1b7bd5585dd0b4c5751b6b554b8facdf320aaefc094`.

### Devnet-сценарий Week 10

После успешных локальных проверок и upgrade используется существующий тестовый
Vault Week 9. Скрипт выводит 250 000 минимальных единиц shares (0,25 shares при
6 decimals); `min_assets_out` берётся из снимка до операции. Он проверяет адреса,
администратора, владельцев аккаунтов, mint/authority и реальные балансы.

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
cd /mnt/d/MySelf/Projects/Solana/liquidity_vault
ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json" yarn devnet:withdraw
```

Endpoint жёстко задан как Devnet; preflight включён, повторная отправка отключена.
Скрипт сохраняет signature **до единственной отправки** и при неопределённом ответе
только проверяет её статус. RPC-чтения повторяются максимум четыре раза с backoff
2/4/8 секунд; ожидание finalization ограничено 30 проверками. После Finalized
проверяются успешные `burn` и `transferChecked` в упорядоченных inner instructions
(Token Program, суммы, mint, authority, источники и получатели), все изменения балансов
и побайтовая неизменность UserPosition. Параллельный запуск блокируется lock-файлом.

Журнал хранится вне репозитория:
`~/.config/solana/liquidity_vault/week10-smoke/receipts.json`.
Повторный запуск проверяет ту же signature и текущие балансы, не создавая второй
withdraw. При неразрешённом статусе нельзя удалять журнал или вручную повторять
операцию: сначала нужно установить результат сохранённой signature.
Проверка балансов рассчитана на изолированный smoke-сценарий без параллельных
deposit/withdraw/donation; последующие операции закономерно изменят эти значения.

Журнал Week 9 не перезаписывается. Его депозит остаётся историческим результатом;
после вывода прежняя проверка live-балансов `devnet:deposit` уже не описывает
текущее состояние. Не удаляйте старый журнал ради повторного депозита.

### Подтверждённый upgrade и вывод Week 10

**25 октября 2026 года**, сеть Devnet, genesis
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`:

- [Upgrade — Finalized](https://explorer.solana.com/tx/29b7RD2dXQ9bjb3JuqESybZib2C79yqBHkuE6pQEctpchJjXUDmkmT3GfbUKaLkU9fYzb4QAoSu7WSo9L1GX6qSM?cluster=devnet),
  slot `514755758`.
- [Withdraw — Finalized](https://explorer.solana.com/tx/5Zt5XmE7HqemFstY87ppB7tdNGrvP8MQRwCHNqeJxaMgBJeXgtyZkh5DEJF5Wm2h2pahcVdZcQJ6hwPT4G3VdoCm?cluster=devnet),
  slot `514755936`, `meta.err = null`, 34 201 CU, комиссия 0,000005 SOL.
- [Программа](https://explorer.solana.com/address/7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH?cluster=devnet)
  осталась по прежнему адресу. ProgramData
  `J5UyTo8E3xLcmttCxXYRNyTo48P3ZZDqzD28j7jTEopF` и upgrade authority
  `bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe` сохранены.
- Размер кода в существующем ProgramData остался **330 448 байт**. Первые
  **315 384 байта** скачанного `solana program dump` побайтово совпали с локальным
  бинарником; остальные **15 064 байта** проверены как нули. Расширения не было.
- SHA-256 локального кода:
  `e16c39c580fb30f4db11e1360be1605734fb286238fd1b93ac780cdd9181fb8d`.
- SHA-256 полного dump с нулевым хвостом:
  `13842fa398650492d8ab562e6c7f528fc59849a2a06013af3233fbdeb3234b69`.
- Буфер `AjAYGJk7P9HqSnVhNX29NDm6gyrxgVZB1NgieZfkacmj` после upgrade
  отсутствует (`AccountNotFound`); rent возвращён. Баланс кошелька:
  1,6868344 SOL до upgrade → 1,6851744 после upgrade → 1,6851694 после withdraw.

Использованы те же mint, Vault, позиция и ATA, что перечислены в таблице Week 9.
`shares_to_burn = 250_000`, `min_assets_out = 250_000`; при 6 decimals это
сжигание 0,25 shares и получение 0,25 базового токена.

| Показатель, минимальные единицы | До withdraw | После withdraw |
| --- | ---: | ---: |
| Token Vault assets | 1 000 000 | 750 000 |
| ShareMint supply | 1 000 000 | 750 000 |
| ATA shares пользователя | 1 000 000 | 750 000 |
| ATA активов пользователя | 1 000 000 | 1 250 000 |
| Исторический `UserPosition.shares` | 1 000 000 | 1 000 000 |

Все 81 байт UserPosition остались неизменными. Withdraw отправлен один раз;
signature записана до отправки, последующие проверки используют сохранённый журнал.
На Devnet SPL CPI не вывели текстовые метки `Instruction: Burn/TransferChecked`,
поэтому первоначальная проверка строк логов завершилась ошибкой уже после
успешного вывода. Проверка исправлена на фактические inner instructions с их
параметрами; повторная отправка не выполнялась.

Повторный запуск исправленного скрипта прошёл без новой транзакции: SOL-баланс
остался 1,6851694, оба журнала сохранили SHA-256. Для Week 10 это
`c8cfa01ff731349e5cfe712bab612c4ac03f33c544a7ab7e15fb22ede8d299b9`;
для Week 9 — прежний `655ae0141f60954e9604e1b7bd5585dd0b4c5751b6b554b8facdf320aaefc094`.

## Результаты локальной проверки Week 10

Проверено **25 октября 2026 года**, Ubuntu WSL. Все проверки выполнены на
окончательной сборке с `opt-level = "s"`:

| Проверка | Результат |
| --- | --- |
| `cargo fmt --check` | PASS |
| `anchor build` | PASS; SBF 315 384 байт, IDL/типы сгенерированы, ошибок стека нет |
| `cargo test` | **20 passed**: все 10 старых + 10 новых |
| `yarn typecheck` | PASS, включая оба Devnet-скрипта |
| `anchor test --skip-build` | **99 passing (2m)**; Yarn 154,80 s |
| `git diff --check` | PASS; новые файлы дополнительно проверены отдельно |

Все 58 интеграционных тестов Week 8–9 сохранены **без изменений**. Добавлен
41 тест Week 10: последовательные частичные/полные выводы, два владельца,
переданные shares и нулевая история получателя, donation/округление/остаток,
повторный депозит, внешние burns, реальный `u64::MAX`, подмены аккаунтов,
делегат, отсутствующие ATA, подпись, slippage, пустое и несогласованное состояние.
Отрицательные проверки требуют конкретной ожидаемой ошибки и неизменности
снимков аккаунтов; случайный сбой RPC не считается успешным тестом.

В двух новых проверках замораживается Token Vault либо ATA получателя. Логи
preflight подтверждают успешное прохождение burn и последующую ошибку
`TransferChecked`; supply, оба баланса и позиция на validator остаются неизменны.
После thaw тот же вывод успешно выполняется. Эти ошибочные транзакции
отклонены **на preflight**, а не включены в блок; preflight в новых тестах не
отключался. Существующий тест Week 9 отдельно подтверждает откат включённой
локальной транзакции с двумя успешными CPI и ошибкой следующей инструкции.

Сначала обычная release-сборка (364 688 байт) также прошла 20/99 тестов. На Devnet
баланс 1,6868344 SOL был меньше rent её буфера (1,85345324 SOL), а запрос 1 SOL
через faucet завершился отказом (CLI указал возможный rate limit), баланс не изменился. После включения
`opt-level = "s"` бинарник уменьшился до 315 384 байт, rent буфера — до
1,60298892 SOL. Повторно пройдены все проверки; расширение ProgramData не нужно.
Проверки переполнения и логика программы не ослаблялись. Ошибок компиляции или
тестов Week 10 не было; остаются предупреждения макросов Anchor/Solana о
`target_os = "solana"` и устаревшем `AccountInfo::realloc`.

## История: результаты локальной проверки Week 9

Проверено 25 октября 2026 года в существующем Ubuntu WSL окружении:

| Проверка | Результат |
| --- | --- |
| `cargo fmt --check` | PASS |
| `anchor build` | PASS; превышения лимита стека SBF нет |
| `cargo test` | **10 passed**: 9 тестов арифметики и `test_id` |
| `yarn typecheck` | PASS, включая Devnet-сценарий |
| `anchor test --skip-build` | **58 passing (57s)** на собранном бинарнике |
| Devnet upgrade и депозит | PASS; Finalized, бинарник и изменения балансов проверены |
| `git diff --check` | PASS; новые файлы также проверены отдельно |

Все **24 теста Week 8 сохранены без изменений**; добавлено **34 интеграционных
теста Week 9**. Проверены первый и повторный депозиты, второй пользователь,
donation и округление, slippage, ATA/mint/PDA/подписи, недостаточный баланс,
замороженный источник, отсутствие ATA, делегированный доступ и состояние после
сжигания shares. На validator достигнута граница `u64::MAX` с произведением,
которое требует `u128`. Unit-тесты отдельно проверяют переполнение результата,
активов, supply и позиции, оба несогласованных нулевых состояния и округление
на сетке из 29 791 комбинации.

Тест атомарности отправляет настоящую локальную транзакцию с `skipPreflight`:
`transfer_checked` и `mint_to` успешно выполняются, следующая инструкция
завершается ошибкой, а все token accounts, supply и позиция возвращаются к
исходному состоянию. Это проверяет [атомарность транзакций Solana](https://solana.com/docs/core/transactions)
по фактическим логам и данным аккаунтов.

В ходе работы исправлены:

- Превышение 4 KiB стека в сгенерированном `Deposit::try_accounts`: аккаунты
  контекста перенесены в `Box<Account<…>>`; on-chain layout не менялся.
- Гонка между `processed` и `confirmed` в снимках тестов: новые тесты используют
  `confirmed` и для отправки, и для чтения.
- Общий cache `anchor.workspace`: у Week 9 отдельный экземпляр `Program`, поэтому
  его commitment не влияет на старые тесты.

Остаются предупреждения старых макросов Anchor/Solana о `target_os = "solana"`
в host-тестах и `AccountInfo::realloc`; ошибок сборки и итоговых тестов нет.

## История: результаты проверки Week 8

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

- **Week 11:** интеграция стратегии ликвидности и учёт активов по методичке.
- **Week 12:** дополнительные проверки безопасности и интеграция клиента.
- **Week 13:** итоговые сценарии, документация и демонстрация.

Пункты Week 11–13 — предварительный план: подробная методичка этих недель
не предоставлена. Их реализация не входит в текущую работу.
