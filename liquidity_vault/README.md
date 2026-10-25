# Liquidity Vault — Week 11: Raydium CLMM Integration

**Владелец проекта: Бекзат Убниев.**

Учебный Solana-проект: основа хранилища SPL-токенов с отдельным mint долей и
позициями пользователей. Week 8 создаёт аккаунты; Week 9 добавляет внесение
активов и выпуск долей; Week 10 — вывод активов со сжиганием реальных shares.
Week 11 добавляет отдельный Devnet-сценарий Raydium CLMM: свои токены, пул и
позицию, принадлежащую кошельку. Anchor-программа Vault в Week 11 не изменяется.

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
├── scripts/raydium/{config.ts,runtime.ts,checks.ts,cli.ts,policy.test.ts,devnet-proof.json}
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

## Week 11 — Raydium CLMM Integration

В обычном constant-product пуле ликвидность распределена по всему диапазону
цен. CLMM позволяет выбрать ограниченный диапазон: внутри него капитал участвует
в обменах, а вне диапазона позиция становится односторонней и не получает комиссии
за активную ликвидность. Здесь это учебная проверка инфраструктуры стратегии:
активы Liquidity Vault не переводятся в Raydium, а Position NFT остаётся у кошелька.

### Официальные инструменты и сеть

- [Официальные адреса Raydium](https://github.com/raydium-io/raydium-docs-v1/blob/main/reference/program-addresses.mdx)
  и [CLMM `lib.rs`](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/lib.rs)
  независимо подтверждают Devnet ID `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH`.
- Используется официальный `@raydium-io/raydium-sdk-v2` **0.2.74-alpha**,
  `bn.js` **5.2.2**, `decimal.js` **10.6.0**, `@types/bn.js` **5.2.0**.
  Зависимости закреплены в `package.json` и `yarn.lock`; web3.js остаётся 1.98.4.
- Инструкции строятся через `ClmmInstrument` официального SDK, а аккаунты читаются
  через RPC и декодируются официальными layouts. REST-индексация новых пулов и
  наличие токенов в публичном token list не требуются. Основой служат официальные
  [createPool](https://github.com/raydium-io/raydium-sdk-V2-demo/blob/master/src/clmm/createPool.ts)
  и [createPosition](https://github.com/raydium-io/raydium-sdk-V2-demo/blob/master/src/clmm/createPosition.ts).
- Endpoint фиксирован: `https://api.devnet.solana.com`; проверяется Devnet genesis,
  executable CLMM и его системный loader. Mainnet-подстановка отклоняется.

Подходящий **существующий** Devnet AmmConfig найден по PDA и прочитан on-chain:
`CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu`, index **0**, `tradeFeeRate = 2500`
из 1 000 000 (**0,25%**), `tickSpacing = 60`. `protocolFeeRate = 120000`,
`fundFeeRate = 40000` — доли внутри торговой комиссии. Другие прочитанные Devnet
конфигурации: index 1 — 0,01% / spacing 1; index 2 — 0,05% / spacing 10.
Конфигурации не создаются скриптом и не заимствуются из mainnet API.

### Токены, цена и диапазон

BEK Token A и BEK Token B — два новых mint классического SPL Token Program.
У обоих **6 decimals**, единовременный выпуск — **100 токенов** (`100_000_000`
минимальных единиц). Mint authority — рабочий кошелёк, freeze authority отсутствует.
Имена BEK — подписи в документации и отчётах: обычный SPL Mint не хранит имя/символ,
отдельная Metaplex metadata для этих учебных активов не создаётся.

Mint keys и ключ NFT генерируются один раз и сохраняются вне репозитория. Порядок
token0/token1 определяется сравнением 32 байт public key, а не буквами A/B или
лексикографическим сравнением Base58-строк. При одинаковых decimals начальная цена
**1 token1 за 1 token0**, `sqrtPriceX64 = 18446744073709551616 = 2^64`, tick = 0.
Проверяются допустимые пределы sqrt price и строгое попадание цены внутрь диапазона.

Диапазон позиции — **ticks −600…600**, обе границы кратны 60. SDK вычисляет цены
границ и целочисленную ликвидность из целевого вклада **10 token0**. Суммы обоих
активов отдельно пересчитываются из полученной liquidity с округлением вверх.
`amount0Max/amount1Max` допускают **1% slippage** и также округляются вверх;
перед отправкой проверяются балансы. Открытие позиции и внесение ликвидности
выполняются одной атомарной `open_position_with_token22_nft`.

Position NFT использует **Token-2022**, как в актуальном примере Raydium; базовые
BEK-токены остаются классическими SPL. У NFT supply = 1, decimals = 0, mint
authority отозвана. NFT в ATA рабочего кошелька подтверждает контроль над
`PersonalPositionState`, где записаны pool, nft mint, ticks и liquidity.
Проверяются также реальные PoolState, vaults, ObservationState, bitmap и обе
TickArrayState с ликвидностью на границах. Это настоящая CLMM-позиция, а не
обычный token account с произвольным балансом.

В дальнейшем `increase_liquidity_v2` добавляет ликвидность с верхними лимитами
расхода, а `decrease_liquidity_v2` уменьшает её с минимальными выходными суммами.
Обе операции проверяют NFT и привязку позиции к пулу:
[increase](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/increase_liquidity_v2.rs),
[decrease](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/decrease_liquidity_v2.rs).
В Week 11 дополнительное увеличение/уменьшение и передача NFT Vault PDA не выполняются.

### Воспроизводимые команды и восстановление

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$PATH"
cd /mnt/d/MySelf/Projects/Solana/liquidity_vault
export ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json"
yarn install --frozen-lockfile
yarn typecheck
yarn test:raydium
yarn raydium inspect   # только сеть, программа, конфигурация, цена и расчёт
yarn raydium tokens    # два mint и ATA
yarn raydium mint      # единовременный выпуск 100 + 100 токенов
yarn raydium pool      # собственный CLMM pool
yarn raydium position  # Position NFT и начальная ликвидность
yarn raydium verify    # только чтение и проверки, ключ кошелька не нужен
yarn raydium verify --public-proof # проверка опубликованного снимка без внешнего журнала
# yarn raydium all     # те же шаги последовательно; записанные операции не повторяются
```

Рабочий журнал: `~/.config/solana/liquidity_vault/week11-raydium/state.json`.
Рядом лежат три keypair-файла; они находятся **вне Git**. Журнал содержит только
публичные адреса, подписи, снимок балансов и результат проверки. Его нельзя удалять
ради повторного запуска. Для нового окружения сохраните и восстановите внешний
каталог, иначе `all` будет означать создание нового независимого учебного набора.

Мутации защищены lock-файлом. Каждая signature сохраняется атомарно до единственной
отправки с `skipPreflight: false`, `maxRetries: 0`. При потерянном ответе проверяется
сохранённая signature; неопределённый или ошибочный результат останавливает сценарий.
Повторный запуск сначала разрешает статусы записанных шагов и не повторяет mint,
создание pool или вклад. RPC-чтения ограничены четырьмя попытками с backoff 2/4/8 s;
ожидание Finalized — 30 проверок. `verify` не пишет журнал и не отправляет транзакций.
Без внешнего журнала `verify` автоматически использует публичный
[`devnet-proof.json`](scripts/raydium/devnet-proof.json). Этот файл не содержит
ключей и не используется для разрешения новых отправок.

### Реальные результаты Devnet Week 11

Проверено **25 октября 2026 года**. Все шесть транзакций — **Finalized**, ошибок
on-chain нет. У mint A/B supply по `100_000_000`, у позиции liquidity **338374998**;
цена осталась 1:1. Точные границы цены: **0,941767358694…1,061833361253 token1/token0**.

| Объект | Адрес в Devnet |
| --- | --- |
| Wallet / NFT owner / mint authority BEK | [`bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe`](https://explorer.solana.com/address/bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe?cluster=devnet) |
| BEK Token A = token0 | [`9fCGeyDFz86XXhUgT7c9zj4qYVBqrnc6B58Fcvv6zzhP`](https://explorer.solana.com/address/9fCGeyDFz86XXhUgT7c9zj4qYVBqrnc6B58Fcvv6zzhP?cluster=devnet) |
| BEK Token B = token1 | [`FGWg89P3tk45pxLHCy8u1A564jPaVHCJjJnk923iKhyG`](https://explorer.solana.com/address/FGWg89P3tk45pxLHCy8u1A564jPaVHCJjJnk923iKhyG?cluster=devnet) |
| Pool ID | [`CuATcxQ3yxU8MPtp7uiYkZdgYxyBZhNuPwf39XK81A2b`](https://explorer.solana.com/address/CuATcxQ3yxU8MPtp7uiYkZdgYxyBZhNuPwf39XK81A2b?cluster=devnet) |
| PersonalPositionState | [`8Y3rCCZrTTSBaShqtNNPwJ8Xxw2EJcg46rCfG8LgDkj7`](https://explorer.solana.com/address/8Y3rCCZrTTSBaShqtNNPwJ8Xxw2EJcg46rCfG8LgDkj7?cluster=devnet) |
| Position NFT Mint | [`AKbjsHiFyGFLsWB2KRA9Lccbc8Wbzn7oVkT9yDoPajci`](https://explorer.solana.com/address/AKbjsHiFyGFLsWB2KRA9Lccbc8Wbzn7oVkT9yDoPajci?cluster=devnet) |
| Position NFT ATA | `6ypFC13nnEyjTQPZwJQ52btusxyXgmxawsH6ApmD72Fc` |
| Pool token0 vault | `93QwHEoPSXfP6me7xPZFGxaEVtCXuwvphuhLTq9N1zjz` |
| Pool token1 vault | `4aER6FgH241tiadd8RTzsjhoVsiDeAG8bsPiUL84q7hE` |

| Операция | Finalized slot | Explorer / signature |
| --- | ---: | --- |
| Создание mint A и ATA | 514975366 | [437tjWo296jmZkUizsJxwq5YuLA8gq4MU9NrMPaa7xKz2FUVG7uBbWvGrKhBFucJ4mwX3viMybsaURRFcLv7tyiZ](https://explorer.solana.com/tx/437tjWo296jmZkUizsJxwq5YuLA8gq4MU9NrMPaa7xKz2FUVG7uBbWvGrKhBFucJ4mwX3viMybsaURRFcLv7tyiZ?cluster=devnet) |
| Создание mint B и ATA | 514975379 | [2F12hbVVaASztLcHMp45VFoFQj5kttK47B2qnigYiQr3UJV4a8QRG1kp9W44fT6BV2pQ9cuRFQ3jqbAGow2rKF1J](https://explorer.solana.com/tx/2F12hbVVaASztLcHMp45VFoFQj5kttK47B2qnigYiQr3UJV4a8QRG1kp9W44fT6BV2pQ9cuRFQ3jqbAGow2rKF1J?cluster=devnet) |
| Выпуск 100 BEK A | 514975391 | [5JkaBsY2t7RQ1VKszM4q2asEbfNKeGay9wL1uYfygdihoMwtpUAcRRrnp1CNzFj9AXG9G6miMrVpZEq2ET4LNZ1n](https://explorer.solana.com/tx/5JkaBsY2t7RQ1VKszM4q2asEbfNKeGay9wL1uYfygdihoMwtpUAcRRrnp1CNzFj9AXG9G6miMrVpZEq2ET4LNZ1n?cluster=devnet) |
| Выпуск 100 BEK B | 514975403 | [4YpJA6WWeDNJtJTHCjdDCYxPXz2A5QCCV8ZzEj2KsX3YRkaHcVWX9AR6uUcKYjafFgEFCnaKSgPLd2nJS9GWRjMe](https://explorer.solana.com/tx/4YpJA6WWeDNJtJTHCjdDCYxPXz2A5QCCV8ZzEj2KsX3YRkaHcVWX9AR6uUcKYjafFgEFCnaKSgPLd2nJS9GWRjMe?cluster=devnet) |
| Создание CLMM pool | 514975415 | [RYJpyZwiVW6icsUzE3e8WzC6gmo9QoP6vAU3KMF6gVymJP7nRXUrwUwdkxeVLcKYdmLjdjLG1mEmiYqcu6GyDmM](https://explorer.solana.com/tx/RYJpyZwiVW6icsUzE3e8WzC6gmo9QoP6vAU3KMF6gVymJP7nRXUrwUwdkxeVLcKYdmLjdjLG1mEmiYqcu6GyDmM?cluster=devnet) |
| Открытие позиции, NFT и вклад 10 + 10 | 514975428 | [3jLFPtLQ7zBvgQzxLsa8rzb6h7EvpGBNxujmhu2wYseZSUYA9FbBMtQfiycSJtLiu5zzYNVj7Zi64UsCfszgCZFP](https://explorer.solana.com/tx/3jLFPtLQ7zBvgQzxLsa8rzb6h7EvpGBNxujmhu2wYseZSUYA9FbBMtQfiycSJtLiu5zzYNVj7Zi64UsCfszgCZFP?cluster=devnet) |

Отдельной транзакции добавления ликвидности не было: первоначальный вклад выполнен
при открытии позиции. Перед вкладом в кошельке было по 100 токенов, в vaults — 0;
после — по 90 в кошельке и по 10 в vaults. NFT принадлежит кошельку, не Vault PDA.
Тестовый SOL: **1,6851694 → 1,52314352**, разница **0,16202588 SOL** на rent и комиссии.
Дополнительный airdrop и upgrade программы Liquidity Vault не потребовались.

### Проверки Week 11 и исправления

| Проверка | Реальный результат |
| --- | --- |
| `cargo fmt --check` | PASS |
| `anchor build` | PASS, программа Vault не изменена |
| `cargo test` | **20 passed**, все прежние тесты сохранены |
| `anchor test --skip-build` | **99 passing (2m)**, Yarn 140,34 s |
| `yarn typecheck` | PASS |
| `yarn test:raydium` | **19 passing**, отдельные offline-тесты |
| `yarn raydium all` | PASS, 6 транзакций Finalized |
| Повторный `all` | PASS, без новых транзакций и повторного вклада |
| `verify --public-proof` без `ANCHOR_WALLET` | PASS, только RPC-чтения, без записи журнала |
| `git diff --check` и проверки новых файлов | PASS |

Новые offline-тесты проверяют подмены сети, program/config address, owner,
discriminator, размеров аккаунтов, fee tier, spacing и tick range; границы sqrt
price, расчёт лимитов, неверный публичный manifest и сохранение signature до
отправки. Отдельно моделируются потерянный ответ и подтверждённая ошибка: повторная
транзакция не создаётся. Это дополнение к реальной Devnet-проверке, не её замена.

Повторный полный запуск и отдельный `verify` сохранили исходные шесть signatures,
балансы, liquidity и SOL **1,52314352**. SHA-256 внешнего журнала до/после и
публичного `devnet-proof.json` одинаков:
`7a0e4d61bf4f5608075cb29908180f0b049637ccf759bcf4e88916750fa2a60c`.

До отправок исправлены отсутствие TypeScript-типов `bn.js`, опечатка в строке
системного BPF loader и первоначальное предположение об index 1 fee config.
Проверки корректно остановили сценарий; затем были прочитаны реальные Devnet
конфигурации и выбран index 0. Суммы токенов рассчитываются отдельно через
`getAmountsForLiquidity` из liquidity и подтверждены фактическим вкладом 10 + 10.
On-chain ошибок, отключения preflight и повторных отправок не было.

Anchor.toml, Rust-код, Cargo-зависимости, PDA и Program ID Vault, старые тесты и
Devnet-скрипты Week 9–10 сохранены без изменений. Новые ключи и рабочий журнал
лежат вне репозитория; публичный proof содержит только проверяемые данные.
`node_modules`, `target` и validator ledger не отслеживаются; временный ledger
после остановки validator удалён. Commit, push и merge не выполнялись.

Проверка рассчитана на изолированный учебный пул: ожидается цена 1:1, единственная
позиция и сохранение выпущенных токенов между кошельком и vaults. Если кто-то
впоследствии совершит swap, добавит ликвидность или владелец переместит NFT,
строгая проверка исторического снимка может отклонить новое состояние. Devnet может
сбрасываться, RPC ограничивает запросы, а SDK имеет статус alpha. Эти ограничения
не маскируются как успешный результат.

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

- **Week 12:** по следующему заданию — интеграция стратегии с Vault, модель
  владения Position NFT, учёт вложенных активов, безопасные CPI increase/decrease
  liquidity и соответствующие проверки. Текущая позиция остаётся у кошелька.
- **Week 13:** итоговые сценарии, документация и демонстрация.

Пункты Week 12–13 — предварительный план: подробная методичка этих недель
не предоставлена. Их реализация не входит в текущую работу.
