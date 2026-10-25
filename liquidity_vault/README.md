# Liquidity Vault — Week 13: Vault-owned CLMM Liquidity

**Владелец проекта: Бекзат Убниев.**

Учебный Solana-проект: основа хранилища SPL-токенов с отдельным mint долей и
позициями пользователей. Week 8 создаёт аккаунты; Week 9 добавляет внесение
активов и выпуск долей; Week 10 — вывод активов со сжиганием реальных shares.
Week 11 добавляет отдельный Devnet-сценарий Raydium CLMM: свои токены, пул и
позицию, принадлежащую кошельку. Anchor-программа Vault в Week 11 не изменяется.
Week 12 добавляет admin-only стратегию с настоящим CPI SwapV2 и обратным обменом.
Week 13 добавляет новую позицию с NFT под контролем Vault, LP CPI и сбор комиссий.
**Статус Week 12: DONE** — локальные тесты пройдены; Devnet upgrade, оба настоящих
CPI swap, безопасный end и последующие deposit/withdraw подтверждены finalized.

**Статус Week 13: DONE** — полный Devnet LP-цикл, положительный сбор fees и безопасный выход подтверждены finalized.

## Стек и сеть

- Rust, Anchor CLI / `anchor-lang` / `anchor-spl` **0.31.1**.
- Классическая программа SPL Token (`Tokenkeg…`) для A/B/shares; Token-2022 для Position NFT.
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
по-прежнему допускают только классический SPL Token для A/B/shares.
Новый модуль liquidity отдельно проверяет Token-2022 NFT через token interface.

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
│   └── src/{lib.rs,math.rs,strategy.rs,raydium.rs,liquidity.rs}
├── scripts/{prepare-local.sh,devnet-deposit.ts,devnet-withdraw.ts}
├── scripts/raydium/{config.ts,runtime.ts,checks.ts,cli.ts,policy.test.ts,devnet-proof.json}
├── scripts/strategy/{client.ts,journal.ts,devnet.ts,verify-upgrade.ts,prepare-fixtures.ts,policy.test.ts}
├── scripts/strategy/{devnet-status.json,upgrade-proof.json,devnet-proof.json}
├── scripts/liquidity/{client.ts,journal.ts,devnet.ts,verify.ts,policy.test.ts}
├── scripts/liquidity/{devnet-status.json,upgrade-proof.json,devnet-proof.json,asset-report.json}
├── tests/{liquidity_vault.ts,deposit.ts,withdraw.ts,strategy.ts,liquidity.ts}
├── tests/fixtures/liquidity.ts
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
| `Strategy` | `[b"strategy", vault]` | Liquidity Vault; неизменяемые привязки пула и состояние стратегии |
| `LiquidityPosition` | `[b"liquidity", strategy]` | Liquidity Vault; привязки CLMM-позиции и счётчики её цикла |

`VaultConfig` содержит `administrator`, `asset_mint`, `share_mint`, `token_vault`,
три bump и `version`. Размер с дискриминатором Anchor: **140 байт**.
Без активной стратегии `version = 1`; в Week 12 старший бит служит блокировкой,
поэтому во время стратегии без позиции значение равно `0x81` (129).
Week 13 добавляет флаг открытой позиции: `0xc1` (193); schema mask — `0x3f`.

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

- Для deposit/withdraw только классический SPL Token: Token-2022 assets и transfer fees не поддерживаются.
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

## Week 12 — Vault Strategy & Raydium CPI

Этот раздел описывает исходный Week 12 и его исторические доказательства.
В Week 13 добавлены LP-позиция и дополнительный lock bit; актуальные результаты
и ограничения приведены в разделе Week 13 ниже.

### Архитектура и совместимость

`Strategy` — отдельный PDA `[b"strategy", vault]`, **314 байт** с дискриминатором.
Он хранит Vault, администратора, единственный разрешённый pool/config, quote mint,
quote ATA, оба Raydium token vaults, observation, фактический quote-баланс после
последней операции, счётчик swap, `active` и bump. Привязки нельзя заменить после
инициализации. Разрешён канонический CLMM-пул, созданный администратором Vault,
с парой asset/quote; глобальный произвольный CPI target отсутствует.

`VaultConfig` (140 байт), `UserPosition` (81 байт), дискриминаторы, старые seeds,
Program ID, порядок аккаунтов deposit/withdraw и старые коды ошибок сохранены.
Структурной миграции нет. Единственное расширение семантики старого поля:
`version & 0x7f` — версия схемы 1, `version & 0x80` — активная стратегия.
Клиентам, сравнивающим весь byte с 1, нужно учитывать этот флаг. Сам on-chain
deposit/withdraw допускает только значение 1; при 129 возвращает `StrategyActive`
до расчётов и token CPI. Пользователь не может обойти блокировку, опустив Strategy
из списка аккаунтов: guard находится в обязательном VaultConfig.

Исторический `UserPosition.shares` остаётся суммой выпущенных долей. Swap и
withdraw его не уменьшают; права на вывод определяются реальным балансом shares.
Старые Vault без Strategy продолжают использовать исходные формулы.

Жизненный цикл:

1. `initialize_strategy()` — подпись сохранённого администратора, проверка пары,
   пула и положительных активов/supply/liquidity; создание Strategy и quote ATA,
   установка `active=true` и блокировки Vault.
2. `swap(a_to_b, amount, min_amount_out, sqrt_price_limit_x64)` — только тот же admin;
   обмен A→B или B→A между двумя token accounts того же Vault.
3. `end_strategy()` — только admin, реальный B **и** записанный B равны нулю;
   при ненулевом share supply должен остаться A. Снимает обе блокировки атомарно.
4. `start_strategy()` — повторное включение существующей стратегии после end;
   pool/mints/accounts не меняются. Повторная инициализация запрещена.

Базовый Token Vault остаётся PDA token account. Второй счёт — канонический ATA
Token B с authority = Vault PDA, classic SPL Token owner. `init_if_needed` относится
только к этому ATA: заранее созданный правильный ATA принимается, его реальный
баланс сразу учитывается. Strategy всегда создаётся через `init`.

### Настоящий SwapV2 CPI

Интеграция сверена с [официальным SwapV2](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/swap_v2.rs),
[IDL Raydium](https://github.com/raydium-io/raydium-idl/blob/master/raydium_clmm/raydium_clmm.json)
и установленным SDK `0.2.74-alpha`. Используется минимальный проверяемый ABI,
без подключения другого Anchor из CPI crate; Anchor проекта остался **0.31.1**.

Данные CPI: дискриминатор SwapV2 `[43,4,237,11,26,201,30,98]`, `amount:u64`,
`other_amount_threshold:u64`, `sqrt_price_limit_x64:u128` little-endian,
`is_base_input=true`. Порядок аккаунтов: Vault signer, config, pool, input/output
Vault token accounts, input/output pool vaults, observation, Token, Token-2022,
Memo, input/output mints; remaining accounts — bitmap и 1–3 tick arrays.
Signer seeds: `[b"vault", asset_mint, vault.bump]`; admin подписывает внешнюю
Vault-инструкцию, Vault PDA подписывает внутренний Raydium-вызов через
`invoke_signed`. Получатель не задаётся пользователем.

On-chain закреплён executable Devnet CLMM
`DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH`. Проверяются ownership,
дискриминаторы/размеры аккаунтов, canonical pool/vault/observation/bitmap PDAs,
связи Strategy/Vault/pool/mints, SPL authorities и фиксированные program IDs.
Tick arrays должны принадлежать этому пулу, иметь canonical PDA и правильный
start index; первая соответствует текущему tick, остальные упорядочены по
направлению. Read-only, повторные и чужие массивы отклоняются.

`amount` и минимум строго положительны. Price limit обязателен, внутри пределов
Raydium и с правильной стороны от текущей цены. Devnet-клиент берёт quote из
предварительной симуляции именно Vault CPI, устанавливает минимум 99% quote и
sqrt price limit ±1%. Доказательством выполнения служит отдельная finalized
транзакция, а не эта симуляция. После CPI оба token accounts перечитываются:
потрачено ровно `amount`, получено не меньше минимума и больше нуля. Частичный fill
по price limit приводит к `PartialSwap` и откату всей транзакции. Счётчик и дельты
используют checked arithmetic. `StrategySwapEvent` фиксирует реальные результаты.

### Завершение, donations и границы стратегии

В исходном Week 12 это spot-стратегия без открытия LP-позиций, займа и открытых
ордеров. `recorded_quote_balance` — последний наблюдённый остаток B,
а не рыночная оценка и не фиктивный счётчик долга. End проверяет его вместе с
реальным ATA. Отдельный Rust-тест покрывает запрет end при recorded B > 0 и
actual B = 0; такое состояние нельзя создать доступными инструкциями стратегии.

Прямой перевод B до end блокирует разблокировку. Администратор обменивает весь
остаток B обратно через тот же CPI; sweep, burn или вывода B на свой кошелёк нет.
Пыль, не дающая положительный output, может потребовать небольшого внешнего
пополнения B перед обратным swap. Это ограничение доступности: посторонний может
повторно посылать donations. После безопасного end новый перевод B считается
подаренным активом вне базовой оценки shares; admin может снова запустить
стратегию и конвертировать его. A-donations входят в фактический баланс базового
Vault и старые формулы. Для повторного запуска нужен положительный share supply.

Пока стратегия активна, deposit/withdraw заблокированы даже при B = 0, до end.
Admin выбирает момент сделок и способен причинить торговый убыток; полного NAV,
автоматического ребалансирования, price oracle для оценки shares и механизма
выхода без admin в Week 12 нет. Поддерживаются только classic SPL Token assets,
активная ликвидность в текущем диапазоне и до трёх tick arrays. Трансферные hooks,
Token-2022 assets и перенос позиции не реализованы.

**NFT-позиция Week 11 принадлежит кошельку `bnCwy…21pjDe`, а не Vault PDA.**
Ни она, ни её NFT не передаются стратегии. Исторический Week 11 checker проверяет
начальную цену 1:1; после будущих swap цена может измениться. Для Week 12
используется собственная проверка, допускающая реальную цену после round trip.

### Локальные проверки Week 12

Локальный validator исполняет настоящий Devnet CLMM ELF: ProgramData slot
`513147960`, 2 528 752 байта, SHA-256
`60255f5ce990ef6ac6847e2316400d2dc2cb83968cb885bf44d6dfac2531ad43`.
`yarn strategy:fixtures` загружает executable и публичный AmmConfig, проверяет
сеть/owner/формат и сохраняет manifest в игнорируемом `target/fixtures/`.
Тесты создают собственные локальные mint/pool/LP, используют одноразовые ключи
и оба порядка asset mint в Raydium-паре. Mock Raydium-программы нет.

Проверены: создание/повторный запуск/завершение, оба swap, реальные балансы и
неизменность shares, запрет старых deposit/withdraw, возобновление после end,
admin/signature/PDA/mint/token-program/pool-vault/bitmap/tick подмены, недостаток
средств, zero amount/minimum, price/slippage, frozen transfer, partial fill,
donations, заранее созданный ATA. Ошибки сравниваются с конкретными кодами и
снимками всех затронутых аккаунтов. Отдельная **ошибочная локальная ledger-
транзакция** проходит Raydium CPI, затем откатывается по `PartialSwap`: это
проверяет атомарность исполнения, а не только симуляции. Только этот негативный
localnet-тест использует `skipPreflight`; Devnet всегда сохраняет preflight.

| Проверка | Результат |
| --- | --- |
| `anchor build` | PASS; SBF 436 992 байта, IDL/типы созданы |
| `cargo test` | **25 passed**: 20 прежних + 5 стратегии |
| `anchor test --skip-build` | **146 passing (2m)**: 99 прежних + 47 стратегии; Yarn 166,64 s |
| `yarn test:raydium` | **19 passing**, Week 11 без изменений |
| `yarn test:strategy-policy` | **10 passing**: журнал, потерянный ответ, ошибка записи, failed/pending signatures, проверяемое истечение blockhash |
| `yarn typecheck` | PASS |
| `cargo fmt --check`, `git diff --check` | PASS; новые файлы также проверены отдельно |
| Devnet verification | PASS: binary match, 9 finalized операций Vault, оба CPI и безопасное конечное состояние |

### Devnet Week 12: фактический статус

Старый Vault Week 9/10 использует другой mint `97EfbG…fe5S`, поэтому новый
сценарий создал отдельные PDA для BEK Token A под **тем же Program ID**.
Старый Vault сохранился без изменений:

| Аккаунт | Созданный Devnet-адрес |
| --- | --- |
| BEK A Vault | `7f25QLNCZEKp95L94eLgJVAq5sWvejSJAWYd6MwvYaFG` |
| A token vault | `jNvLD91PmrYYwPjSURsZL9fgUuHP6LXy46C6ASKV3tG` |
| Share mint | `8TyFHFEmL4fnW4VL8i7wNoWi5nKeDTArwh2BicYPckZe` |
| Strategy PDA | `CxErYVrwT5pXXYeXfi31N9i2MG9E5VmjbRCRCEaxqBuU` |
| Quote B ATA | `3ttDJsNhBzTBrSvhCtGYek8mQMe5DTqPi8D2GHgHT3Xo` |

Публичные доказательства: [upgrade-proof.json](scripts/strategy/upgrade-proof.json),
[devnet-proof.json](scripts/strategy/devnet-proof.json) и read-only
[devnet-status.json](scripts/strategy/devnet-status.json). Сохранены все полные
signatures, slots, Explorer links, снимки каждого этапа, параметры swap,
вложенные SPL-переводы и результаты проверок блокировки.

Upgrade finalized в slot **514987336**. ProgramData содержит ровно **436992 байта**
бинарника, полностью совпадающего с локальной сборкой; SHA-256
`d2358cb7f896865b9ac106b665b777b8f060bb1b8c5aaa71fca0e4e7ae00da2b`.
Upgrade authority сохранён, именованный buffer закрыт. Проверены Devnet genesis,
собственный пул, mint supply/decimals/authorities, ликвидность **338374998**,
неизменность старого Vault и сохранение LP/NFT у кошелька.

| Операция | Slot | Signature / Explorer (Devnet) |
| --- | ---: | --- |
| Upgrade | 514987336 | [4jkjDPze…PYSxVM3](https://explorer.solana.com/tx/4jkjDPzewK8tgPL1gxPQtaK5wiMbSM7NHkES22NfKs8yCZuM2nzHJALcwA93Va1Bmc5EqmmkHqCcS9wBaPYSxVM3?cluster=devnet) |
| Initialize Vault | 514987718 | [4c9WqwTU…d3yitpH](https://explorer.solana.com/tx/4c9WqwTUGWQkgsJmZgpS3LXtrUembmv6buTsKZqdn3r64rBdwi26Wv2tvumRqju44pLoS4Hceb82ngDT5d3yitpH?cluster=devnet) |
| Open user position + share ATA | 514987731 | [5eUswZtQ…qyZ8RjJ](https://explorer.solana.com/tx/5eUswZtQAHuwGTFEPNGZFd9eSqKy1P9NWQh7uk4wSubhk6kgMFDUdo3DnCHmsdsmRNoGKQBwoxsnuJC2XqyZ8RjJ?cluster=devnet) |
| Deposit 1 A | 514987741 | [tWT451Tk…iczS6HQ](https://explorer.solana.com/tx/tWT451Tkj8rr7sUc2QreqYBmtyAPhpferWFuqfLfP95wxDBeTHpjbQ2DxZcKgNRuD5Vuf25J2rC6P1wRiczS6HQ?cluster=devnet) |
| Initialize Strategy | 514987753 | [3UphxvRH…XCwhmFo](https://explorer.solana.com/tx/3UphxvRHsLsSB5rZzHTFj2yziH1zEPfsdK3xqyC2dLnLgAxcbKJXaJdQkBNtMJcFLfTrst6eYz3Ko9hKCXCwhmFo?cluster=devnet) |
| A → B | 514987966 | [5c9V5SeW…Ubn7zhp](https://explorer.solana.com/tx/5c9V5SeWwxtX3BRQwwjNqp7Af3big645QgYTM2tQ29mkQFU2eQQJZUS1KYeYTPhD4Vp1hx4p9ot3wuVJZUbn7zhp?cluster=devnet) |
| B → A | 514987980 | [5BxHhCCP…gQDWn8p](https://explorer.solana.com/tx/5BxHhCCPonDuWtxoFJbtZumi3GwqayasXeqo5XnLRXMXbbEkXJSxjqGdBBVjg1GdnaWczWfZnM35Uib4AgQDWn8p?cluster=devnet) |
| End Strategy | 514987992 | [5ytjNTEb…nHkHBy7](https://explorer.solana.com/tx/5ytjNTEbQdotBWuK17EwmqUT9GRnLfiGLUTtQJDgxMejSTEAeqksYqqk7J3kPhaJWRxHAtmhNE5VXKmX8nHkHBy7?cluster=devnet) |
| Deposit после end | 514988709 | [5G6NPfuD…h2xRrwN](https://explorer.solana.com/tx/5G6NPfuD4JYc6NSxSEfZ4aLbYewVYd6DT5om4Tfp3BUcbpivessyUkuD12FGknvLJQMYPnMzu2qowDpC9h2xRrwN?cluster=devnet) |
| Withdraw после end | 514988767 | [2KDCRcxB…u8BdJY4](https://explorer.solana.com/tx/2KDCRcxBuXhCEhnmvJfKGqvcm184WKfiDf2kQmgB3SyihpkhGxTuE1G97tWRKgmHCD2Yew7HYer26SMkHu8BdJY4?cluster=devnet) |

Фактические изменения Vault, все числа ниже в base units (6 decimals):

| Этап | Vault A | Vault B | Share supply | Исторические shares пользователя |
| --- | ---: | ---: | ---: | ---: |
| Перед стратегией, после депозита | 1000000 | 0 | 1000000 | 1000000 |
| После A → B | 990000 | 9974 | 1000000 | 1000000 |
| После B → A и end | 999949 | 0 | 1000000 | 1000000 |
| После контрольного deposit | 1000949 | 0 | 1001000 | 1001000 |
| После контрольного withdraw | **999950** | **0** | **1000000** | **1001000** |

Прямой swap потратил **10000 A**, получил **9974 B**, минимум **9874 B**;
обратный потратил весь B (**9974**), получил **9949 A**, минимум **9849 A**.
Round trip уменьшил активы на **51 base unit A = 0,000051 A** с учётом fee и
округления. Контрольный deposit внёс 1000 A units и выпустил 1000 shares;
withdraw сжёг 1000 shares и вернул 999 A units по фактическому курсу.
Конечное состояние: `active=false`, `version=1`, `recorded_quote_balance=0`,
`swap_count=2`. В обоих swap подтверждены Raydium `stackHeight=2`, по два
`transferChecked` с `stackHeight=3`, реальные amounts/mints/source/destination,
Vault PDA как input authority и pool PDA как output authority. Vault не является
внешним transaction signer; подпись возникает только через `invoke_signed`.

Кошелёк A/B: **90 / 90 → 88,999999 / 90**; pool A/B:
**10 / 10 → 10,000051 / 10**. Старый Vault assets/supply остались
**750000 / 750000**. После обменов tick **−1**, sqrtPriceX64
**18446742672331896339**; ликвидность и ручная NFT-позиция не изменились.

Изначально 1,52314352 SOL не хватало на upgrade; один запрос faucet был отклонён.
Владелец пополнил кошелёк на **5 тестовых SOL**, до **6,52314352 SOL**.
После upgrade, rent новых аккаунтов и всех операций осталось **5,96935936 SOL**.
Первая попытка контрольного deposit после end получила RPC **429** и не попала
в цепочку. Проверены отсутствие транзакции и истечение blockhash на finalized
height **502189290** (lastValid **502188883**); старая подпись сохранена в `retired`
публичного proof. Только после этого выполнена новая успешная транзакция.
Ни swap, ни end повторно не отправлялись; preflight всегда оставался включённым.

Публичные адреса: [Vault program](https://explorer.solana.com/address/7e5CTdFmiZ9wrW96MaiaFrfha1mguGEVEds5m7y2XmrH?cluster=devnet),
[Raydium pool](https://explorer.solana.com/address/CuATcxQ3yxU8MPtp7uiYkZdgYxyBZhNuPwf39XK81A2b?cluster=devnet).

Повторная проверка завершённого сценария:

```bash
yarn strategy check --save-status          # read-only, без ключа
yarn strategy:verify-upgrade 4jkjDPzewK8tgPL1gxPQtaK5wiMbSM7NHkES22NfKs8yCZuM2nzHJALcwA93Va1Bmc5EqmmkHqCcS9wBaPYSxVM3
export ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json"
yarn strategy verify                      # без отправки транзакций
# yarn strategy run — продолжение по внешнему журналу; завершённые этапы пропускаются.
```

`run` вносит 1 BEK A, активирует стратегию, проверяет блокировку старых методов,
обменивает 0,01 A на B, затем весь полученный B обратно, выполняет end,
вносит ещё 0,001 A и погашает 1000 base units shares. Результат не предполагает
возврата исходного количества A: учитываются fee, округление и price impact.
Проверка требует вложенный Raydium `stackHeight=2`, два SPL transfer `=3`,
правильные accounts/data/event, неизменные старые Vault/mints/LP/NFT.

Журнал `~/.config/solana/liquidity_vault/week12-strategy/state.json` хранится
вне Git, подпись записывается **до единственной отправки**. `maxRetries=0`,
preflight включён; после потерянного RPC-ответа проверяется сохранённая подпись.
Неразрешённая или failed подпись останавливает процесс: нельзя удалять журнал
или автоматически создавать повторную сделку. Для отклонённого контрольного
депозита есть отдельная read-only команда `yarn strategy recover-expired-deposit`:
она требует finalized block height выше lastValidBlockHeight, отсутствия подписи
и транзакции в истории, невалидного blockhash и неизменных балансов после end.
Только после этих проверок старая receipt архивируется в `retired`, а следующий
явный `run` может подготовить новую транзакцию. Swap эта команда не повторяет.
Между отправляющими этапами выдерживается 10 секунд. Read RPC имеет ограниченные
повторы. Одновременные запуски защищены внешним `run.lock`; после аварии lock
удаляют только проверив отсутствие живого процесса и результаты подписей.

Исправлены ошибки null-narrowing и типов RPC `stackHeight` в TypeScript,
а также чтение Anchor `SimulateError`: код `StrategyActive` разбирается из
`simulationResponse.logs`, а не из пустого текста исключения. Обе Devnet
симуляции запрета deposit/withdraw вернули именно код 6011; логи сохранены в proof.
SBF-сборка выполнена с boxed Anchor accounts без переполнения стека.
Существующие предупреждения макросов Anchor не препятствуют сборке.
Секреты не добавляются: fixture ELF/IDL/ledger/keypair symlink игнорируются,
Devnet wallet и program/buffer keypairs остаются во внешнем WSL config.

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
yarn strategy:fixtures
anchor test
yarn test:raydium
yarn test:strategy-policy
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

## Week 13 — Vault-owned CLMM Liquidity

Новая CLMM-позиция принадлежит Vault PDA. Все операции управления требуют
подписи администратора, а подпись Vault для Raydium CPI программа создаёт через
`invoke_signed` с прежними seeds Vault. A/B остаются обычными SPL-токенами;
отдельный Position NFT использует Token-2022, без metadata.
**Week 11:** NFT ручной позиции принадлежит личному кошельку и не переносится.
**Week 13:** новый NFT находится в каноническом ATA владельца Vault PDA;
инструкции вывода NFT или изменения получателя нет.

### Совместимость и состояние

Прежние seeds, Program ID, layout VaultConfig (140), UserPosition (81) и Strategy
(314 байт с discriminator) сохранены. Данные позиции хранятся в связанном PDA
`["liquidity", strategy]`: `LiquidityPosition`, 226 байт. Он содержит адреса
позиции/NFT/ATA, ticks, liquidity, вложенные и возвращённые A/B, собранные комиссии,
возвращённую SOL rent, номер цикла и флаг open. После закрытия запись сохраняется;
следующий цикл требует нового NFT и сбрасывает счётчики цикла.

В существующем `VaultConfig.version` младшие 6 бит сохраняют schema version 1,
`0x80` означает активную стратегию, `0x40` — открытую позицию. Поэтому старый
`end_strategy` не может обойти проверку, просто не передав новый PDA.

`inactive (0x01) → active (0x81) → position_open (0xc1) → liquidity_added →
fees_collected → liquidity_removed → position_closed (0x81) → converted_to_A →
inactive (0x01)`.

Deposit/withdraw заблокированы во всей активной стратегии, включая открытую
позицию с нулевой liquidity. End запрещён до фактического закрытия позиции и
нулевого B. Swaps Week 12 сохранены. После безопасного end shares снова
рассчитываются по фактическим A и share supply, с прежним округлением вниз.

### Инструкции и CPI

| Инструкция Vault | Действие Raydium / ограничения |
| --- | --- |
| `open_liquidity_position(lower, upper)` | `open_position_with_token22_nft`, нулевая начальная liquidity; admin оплачивает rent и подписывает новый mint; NFT owner — Vault |
| `increase_liquidity(liquidity, max_a, max_b)` | `increase_liquidity_v2`; списание только с Vault A/B, ненулевая liquidity, ограниченные maxima |
| `collect_fees(min_a, min_b)` | `decrease_liquidity_v2(0)`; liquidity не меняется, реальные дельты Vault учитываются как комиссии |
| `decrease_liquidity(liquidity, min_a, min_b)` | Сначала атомарный collect с liquidity=0, затем частичное/полное уменьшение; principal учитывается отдельно от fees |
| `close_liquidity_position()` | `close_position`; liquidity/fees/rewards = 0, NFT сжигается, mint/ATA/personal position закрываются, rent возвращается Vault |

Проверяются фиксированный executable CLMM Devnet, сохранённый pool, mint pair,
pool vaults, PDA позиции, канонический NFT ATA, owner/amount/supply NFT,
отсутствие delegate/close authority, ticks, tick array PDA/owner/pool и bitmap.
После CPI проверяются реальные balances и personal position. Ошибка возвращает
всю транзакцию в исходное состояние, включая уже выполненный collect.

Диапазон выбирается от **текущего** tick после подготовки B: центр округляется
вниз до tick spacing, затем ±10 spacing. Liquidity и требуемые amounts вычисляются
по текущему `sqrtPriceX64`; deposit округляется вверх, withdrawal вниз. Maxima
увеличены на 1%, minima уменьшены на 1%; максимумы дополнительно ограничены
имеющимися балансами Vault. Это демонстрационный диапазон, не оптимизатор дохода.

Использованы официальные исходники
[open Token-2022](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/open_position_with_token22_nft.rs),
[increase V2](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/increase_liquidity_v2.rs),
[decrease V2](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/decrease_liquidity_v2.rs),
[close](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/close_position.rs)
и [официальный IDL](https://github.com/raydium-io/raydium-idl/blob/master/raydium_clmm/raydium_clmm.json).
SDK закреплён на `0.2.74-alpha`. Совместимость проверяется с фактическим ELF Devnet,
загруженным в локальный validator, и затем реальными Devnet-транзакциями.
Legacy protocol position передаётся для ABI; SDK использует little-endian ticks
для его PDA, а tick arrays используют big-endian start index.

### Учёт активов и ограничения NAV

[`scripts/liquidity/asset-report.json`](scripts/liquidity/asset-report.json)
разделяет cash A/B, principal внутри LP, accrued fees, collected fees и
principal P/L относительно удержания внесённых A/B при текущей цене. Rewards не
поддерживаются: операции допускают только pool без инициализированных reward mint,
а закрытие отдельно проверяет нулевые owed rewards. Если reward будет включён
внешним управляющим pool, потребуются расширение стратегии и отдельная проверка
безопасного выхода; текущая программа не игнорирует обязательства.

Аналитическая цена — `P = sqrtPriceX64² / 2^128` (raw B за raw A), у обоих
mint 6 decimals. `NAV_A = cash_A + principal_A + accrued_fee_A +
floor((cash_B + principal_B + accrued_fee_B) / P)`.
Это **манипулируемая spot-оценка, не безопасный production NAV**, не oracle/TWAP
и не цена для выпуска shares. Округления в отчёте — integer floor; dust может
менять итог на минимальные единицы. Полученные fees уже находятся в cash и
повторно не прибавляются. Principal P/L может быть отрицательным даже при
положительных fees; он не включает swap fees и расходы SOL. Отдельно сохраняется
фактическая разница A между началом и end до проверочного deposit/withdraw.
Возврат SOL rent не считается доходом в Token A.

### Воспроизведение и восстановление

```bash
yarn typecheck
yarn test:raydium
yarn test:strategy-policy
yarn test:liquidity-policy
cargo fmt --check
cargo test
anchor build
anchor test --skip-build
yarn liquidity check
# Только после upgrade и проверки опубликованного бинарника:
yarn liquidity verify-upgrade <UPGRADE_SIGNATURE>
export ANCHOR_WALLET="$HOME/.config/solana/jezqwx/id.json"
yarn liquidity run
yarn liquidity verify
```

Runner работает только с проверенным Devnet genesis, указанными program/pool/mints
и кошельком. Единственный внешний swap ограничен 100 000 минимальных A (0,1 A),
идёт отдельной прямой инструкцией Raydium из личных ATA, не из Vault.
Минимум collect = 1 единица A: нулевой сбор не считается успехом.

NFT keypair и журнал находятся **вне репозитория**:
`~/.config/solana/liquidity_vault/week13-liquidity/`. Сохраняются до отправки;
межпроцессный lock предотвращает одновременный запуск. Preflight включён,
автоповтор отправки отключён. При timeout runner проверяет записанную signature,
не создаёт новый NFT и не повторяет уже финализированный шаг.
`yarn liquidity recover-expired <STEP>` разрешает явную замену только после
истечения block height, отсутствия signature/transaction, недействительности
blockhash и проверки неизменности Vault/NFT/position/balances. Старый receipt
архивируется; затем `run` продолжает цикл. Наблюдаемая failed-транзакция требует
отдельного разбора. `verify` ничего не отправляет.

В публичных proof JSON сохраняются finalized signatures, Explorer links,
балансы по этапам, события с десятичными amounts, CPI stack height/authority,
проверка получателей A/B, бинарный SHA-256 и контроль неизменности старого Vault
и ручной позиции Week 11. Исторические proof Week 11–12 сохраняются.

Дальнейшее развитие: oracle/TWAP и независимая оценка ликвидационной стоимости,
поддержка rewards и аварийного выхода, несколько позиций, автоматизированное
управление диапазоном, независимый аудит. Текущая программа остаётся upgradeable
и доверяет администратору; демонстрация на Devnet не является аудитом.

### Локальные проверки Week 13

| Проверка | Результат |
| --- | --- |
| `cargo fmt --check` | PASS |
| `anchor build` | PASS |
| `cargo test` | **29 passed**, включая прежние 25 |
| `yarn typecheck` | PASS |
| Полный `anchor test --skip-build` | **191 passing**, включая прежние 146 |
| Raydium policy | **19 passing** |
| Strategy policy | **10 passing** |
| Liquidity policy | **13 passing** |
| Devnet proof / повторный `run` / read-only `check` | PASS; 13 finalized receipts, повторных отправок нет |
| `git diff --check`, новые файлы, secrets/scope review | PASS; изменения только в `liquidity_vault/` |

Новые интеграционные проверки исполняют настоящий CLMM ELF: проверяют NFT owner,
fees > 0, частичный и полный withdrawal, закрытие всех трёх аккаунтов,
разблокировку deposit/withdraw, подмены аккаунтов/authority/program/ticks,
неисполнимый slippage и полный откат в фактически отправленной ошибочной локальной
транзакции. Policy-тесты проверяют сохранение подписи до отправки и отсутствие
повторной отправки, включая NFT co-signer, потерянный RPC-ответ и ошибку записи.

При реализации исправлены endian protocol-position PDA, неверный адрес в тесте
подмены NFT recipient и shell glob: после появления `tests/fixtures/` незаключённый
в кавычки `tests/**/*.ts` давал ложный прогон с нулём тестов. Теперь glob передаётся
Mocha в кавычках, полный прогон включает все 191 тест. Сборка сохраняет прежнее
предупреждение макроса Anchor об устаревшем `AccountInfo::realloc`.

### Реальные Devnet результаты Week 13 — DONE

Полный цикл выполнен 25 октября 2026 года. Все 13 транзакций сценария и upgrade
подтверждены **finalized**. Источник чисел — реальные RPC-снимки и подтверждённые
транзакции, не симуляция. Публичные доказательства:
[upgrade](scripts/liquidity/upgrade-proof.json),
[цикл/CPI/signatures](scripts/liquidity/devnet-proof.json),
[аналитический отчёт](scripts/liquidity/asset-report.json).

| Объект | Адрес / значение |
| --- | --- |
| Vault | [`7f25QLNCZEKp95L94eLgJVAq5sWvejSJAWYd6MwvYaFG`](https://explorer.solana.com/address/7f25QLNCZEKp95L94eLgJVAq5sWvejSJAWYd6MwvYaFG?cluster=devnet) |
| Strategy | [`CxErYVrwT5pXXYeXfi31N9i2MG9E5VmjbRCRCEaxqBuU`](https://explorer.solana.com/address/CxErYVrwT5pXXYeXfi31N9i2MG9E5VmjbRCRCEaxqBuU?cluster=devnet) |
| LiquidityPosition PDA | [`AE8bAgsZiwdWuwXeqxowmDiNwkA9qLcuE9g8B1S85QPa`](https://explorer.solana.com/address/AE8bAgsZiwdWuwXeqxowmDiNwkA9qLcuE9g8B1S85QPa?cluster=devnet) |
| Raydium personal position | [`Gg111QYiZGrDCEYyY6WgTFVSXbwFbgvTXGWSPciXrzbs`](https://explorer.solana.com/address/Gg111QYiZGrDCEYyY6WgTFVSXbwFbgvTXGWSPciXrzbs?cluster=devnet) |
| Новый NFT mint | [`FV1UTTVeRYxwHE576GVHVEaESkhddiujZyGmdGbXyVHb`](https://explorer.solana.com/address/FV1UTTVeRYxwHE576GVHVEaESkhddiujZyGmdGbXyVHb?cluster=devnet) |
| NFT owner во время жизни позиции | [`7f25QLNCZEKp95L94eLgJVAq5sWvejSJAWYd6MwvYaFG`](https://explorer.solana.com/address/7f25QLNCZEKp95L94eLgJVAq5sWvejSJAWYd6MwvYaFG?cluster=devnet) |
| Диапазон ticks | -660 … 540; выбран при текущем tick -27 |
| Liquidity после внесения | 11241380 |
| Внесено principal | 314355 A / 350000 B |
| Возвращено principal | 317562 A / 346802 B |
| Начислено / реально собрано fees | 6 / 6 A; 0 B |
| SOL rent возвращена Vault | 5267960 lamports (не включена в A NAV) |

Все A/B в таблицах — **минимальные единицы**, 1 токен = 1 000 000 единиц.
Внешний swap: **100000 A → 99457 B**, один раз из личных ATA.
Tick изменился -27 → -33, оставаясь внутри диапазона.
Глобальный fee growth A увеличился с 52662149628451 до
63742340658514. До collect поле personal `owedA` было
0: Raydium обновляет его лениво; расчёт
по on-chain global/outside/checkpoint давал 6.
Collect реально увеличил Vault A на **6**, после него accrued/owed = 0.

Частичное уменьшение: liquidity 11241380 → 5620690,
возврат 158781 A / 173401 B. Затем liquidity = 0,
суммарный возврат principal 317562 A / 346802 B.
После close RPC возвращает null для NFT mint, NFT ATA и personal position;
record.open = false. У закрытого NFT **нет текущего owner**: указанный Vault
являлся владельцем токена во время жизни позиции, затем NFT сожжён.

Обратный swap: **445082 B → 444816 A**. После end Vault содержит
997979 A / 0 B, share supply 1000000; active=false,
version=1. Фактический результат стратегии до проверочного deposit/withdraw:
**-1971 A** относительно исходных 999950. Положительные fees
не покрыли издержки swap и округления; прибыль всего цикла не заявляется.

После end внесено 1000 A, выпущено
1002 shares; затем сожжено
1000 shares и выведено 997 A.
Итог: **997982 A / 0 B**, supply 1000002, исторически
выпущенные shares в UserPosition 1002002. История при withdrawal
не уменьшается. Старый Vault и аккаунты ручной позиции Week 11 сохранили
контрольные хеши owner/data.

| Этап | Cash A | Cash B | LP liquidity | LP principal A / B | Accrued fees A / B | Аналитический spot NAV в A |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| До стратегии | 999950 | 0 | 0 | 0 / 0 | 0 / 0 | 999950 |
| Start | 999950 | 0 | 0 | 0 / 0 | 0 / 0 | 999950 |
| Подготовка B | 549950 | 448280 | 0 | 0 / 0 | 0 / 0 | 999420 |
| Открытие | 549950 | 448280 | 0 | 0 / 0 | 0 / 0 | 999420 |
| Внесение LP | 235595 | 98280 | 11241380 | 314354 / 349999 | 0 / 0 | 999418 |
| Внешний swap | 235595 | 98280 | 11241380 | 317562 / 346802 | 6 / 0 | 999681 |
| Сбор fees | 235601 | 98280 | 11241380 | 317562 / 346802 | 0 / 0 | 999681 |
| Частичное уменьшение | 394382 | 271681 | 5620690 | 158781 / 173401 | 0 / 0 | 999681 |
| Полное уменьшение | 553163 | 445082 | 0 | 0 / 0 | 0 / 0 | 999681 |
| Закрытие | 553163 | 445082 | 0 | 0 / 0 | 0 / 0 | 999681 |
| B → A | 997979 | 0 | 0 | 0 / 0 | 0 / 0 | 997979 |
| End | 997979 | 0 | 0 | 0 / 0 | 0 / 0 | 997979 |
| Deposit после end | 998979 | 0 | 0 | 0 / 0 | 0 / 0 | 998979 |
| Withdraw после end | 997982 | 0 | 0 | 0 / 0 | 0 / 0 | 997982 |

Все signatures и Explorer links (Devnet):

| Шаг | Finalized signature |
| --- | --- |
| Upgrade | [53dJQAEZ75XLxts5zY7mQPJ633PQgHYHJZT87DkUHa19J9sbg4kEiT7TYWxLpg95PPt9Vbz2pY5JP4sFQKpXh9sU](https://explorer.solana.com/tx/53dJQAEZ75XLxts5zY7mQPJ633PQgHYHJZT87DkUHa19J9sbg4kEiT7TYWxLpg95PPt9Vbz2pY5JP4sFQKpXh9sU?cluster=devnet) |
| Start | [RVALmiz2Vnoev3xen8EvGDciNtjLs9Y36CfGD8T7rbXzotTm2ZuupQaP1KHJXyaNPNZRbXzyW31A4tkXUBywAfv](https://explorer.solana.com/tx/RVALmiz2Vnoev3xen8EvGDciNtjLs9Y36CfGD8T7rbXzotTm2ZuupQaP1KHJXyaNPNZRbXzyW31A4tkXUBywAfv?cluster=devnet) |
| Подготовка B | [3WLmiTy2yS17CCRq5Q1sqjwkPUYUEWHV9QcULbtAvyjR82qJLwf7ovqjc6iLdbBEf5oDhzokP95QdepD8hHi6MV7](https://explorer.solana.com/tx/3WLmiTy2yS17CCRq5Q1sqjwkPUYUEWHV9QcULbtAvyjR82qJLwf7ovqjc6iLdbBEf5oDhzokP95QdepD8hHi6MV7?cluster=devnet) |
| Открытие | [27aGJQmETziSEUY78YYQHBxtg83nqe7pr6kMxrRd3kYjh1GgLn8NXWSdrgWERSD5FKkyQBMA8exrX8vMfsXganXM](https://explorer.solana.com/tx/27aGJQmETziSEUY78YYQHBxtg83nqe7pr6kMxrRd3kYjh1GgLn8NXWSdrgWERSD5FKkyQBMA8exrX8vMfsXganXM?cluster=devnet) |
| Внесение LP | [s5DLesejbHXLNGYsA9mZGfmp48cHVB21L3NF3LpExx6NScZPjVM4fkzgb1BD88CtpZGvH84YWuw88Mpbw6E95kF](https://explorer.solana.com/tx/s5DLesejbHXLNGYsA9mZGfmp48cHVB21L3NF3LpExx6NScZPjVM4fkzgb1BD88CtpZGvH84YWuw88Mpbw6E95kF?cluster=devnet) |
| Внешний swap | [3rcHDe2zhLWkB2wMbdre7s32XhQV6amJfueLpmJHi9xGbGRLedVkLzWQdKhmjUfC4Wcb7NpDzHAXAcYr1bsf5Vdh](https://explorer.solana.com/tx/3rcHDe2zhLWkB2wMbdre7s32XhQV6amJfueLpmJHi9xGbGRLedVkLzWQdKhmjUfC4Wcb7NpDzHAXAcYr1bsf5Vdh?cluster=devnet) |
| Сбор fees | [5vhWEMgKcGFbNYhkZGZ4gvWhaCoHbKUhGEFNm11xLki69T7tM8wmZMDhMQwH3TCzAM9zewgq1H8ApFBNyLt4V1NH](https://explorer.solana.com/tx/5vhWEMgKcGFbNYhkZGZ4gvWhaCoHbKUhGEFNm11xLki69T7tM8wmZMDhMQwH3TCzAM9zewgq1H8ApFBNyLt4V1NH?cluster=devnet) |
| Частичное уменьшение | [2vPt8QYcPuQxetUZAa9CA3oC28Ya8De3CjQEZN27Xt5j7QpSWf3sMN22aC9814tsXJc9HucMPYC6PsY1YnRKYa3z](https://explorer.solana.com/tx/2vPt8QYcPuQxetUZAa9CA3oC28Ya8De3CjQEZN27Xt5j7QpSWf3sMN22aC9814tsXJc9HucMPYC6PsY1YnRKYa3z?cluster=devnet) |
| Полное уменьшение | [2GYBPNw3479WaCWwFZuuGsiP11CLzxFv78XYgnqUVTGgwXh4kWB6xkzpcNbiCq6FaW6Z9pygwkDR91nH2Hueu6yz](https://explorer.solana.com/tx/2GYBPNw3479WaCWwFZuuGsiP11CLzxFv78XYgnqUVTGgwXh4kWB6xkzpcNbiCq6FaW6Z9pygwkDR91nH2Hueu6yz?cluster=devnet) |
| Закрытие | [4fedETSazi2cVYF6uSyctEJCDzhcmRmFQKcaAmGsJNQjtEdu8ZuAXodG2dfWoSq24dTDQHKb7gD9Hn6zQEXyUDzp](https://explorer.solana.com/tx/4fedETSazi2cVYF6uSyctEJCDzhcmRmFQKcaAmGsJNQjtEdu8ZuAXodG2dfWoSq24dTDQHKb7gD9Hn6zQEXyUDzp?cluster=devnet) |
| B → A | [4zAR379cgkNsBRGfEKizjXGac6JwvqdFmgZZzr5cSmJEvBgXby7DDsqbz2C4rQfqWNyPyT4znA6QgfaTmVxFjBN9](https://explorer.solana.com/tx/4zAR379cgkNsBRGfEKizjXGac6JwvqdFmgZZzr5cSmJEvBgXby7DDsqbz2C4rQfqWNyPyT4znA6QgfaTmVxFjBN9?cluster=devnet) |
| End | [2zWt1TpxcvUsr9upruCStE5fdgst5xvHx6maUEHPywQq1JUR8Ya9q21Kw3FgbpnJ8e96BNzgwPf3EBPar7CVZm1u](https://explorer.solana.com/tx/2zWt1TpxcvUsr9upruCStE5fdgst5xvHx6maUEHPywQq1JUR8Ya9q21Kw3FgbpnJ8e96BNzgwPf3EBPar7CVZm1u?cluster=devnet) |
| Deposit после end | [5JKBT7pFuJ1yH9LGBqWzRE69kEEPFikjpALYGmkkjSWpdz7SWibtWSs3xUasjF3XW4ssiRHiJeKHww9YcyzAk4W](https://explorer.solana.com/tx/5JKBT7pFuJ1yH9LGBqWzRE69kEEPFikjpALYGmkkjSWpdz7SWibtWSs3xUasjF3XW4ssiRHiJeKHww9YcyzAk4W?cluster=devnet) |
| Withdraw после end | [35WxorM7aEWFjuzt15DK93eRsPNqYT6wMBJTF2FYqEaiCqABj2nJ2Av1Q67xnaMUykaU2gMJeVj4rUcdJoYFgdWB](https://explorer.solana.com/tx/35WxorM7aEWFjuzt15DK93eRsPNqYT6wMBJTF2FYqEaiCqABj2nJ2Av1Q67xnaMUykaU2gMJeVj4rUcdJoYFgdWB?cluster=devnet) |

Опубликованный SBF: 571472 байт, SHA-256
`f3890004ec02a10cfe4e4d05d476db3c9217ec6674d0b2a2ac660d3a164849de`, slot 514998370; буфер закрыт.

Повторный `yarn liquidity run` прошёл без новых signatures и без изменения
балансов/позиции; повторный `check` прочитал то же безопасное финальное состояние.
Публичные JSON не содержат keypair/seed/private key. Commit, push и merge не выполнялись;
HEAD остался `b11b413`, изменения ограничены `liquidity_vault/`.
