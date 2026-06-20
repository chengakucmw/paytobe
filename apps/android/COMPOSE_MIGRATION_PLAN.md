# VelarumPay Android：WebView → Jetpack Compose 原生重写
## 第一步：调研结论 + 迁移计划（待确认，未写业务代码）

> 这份文档是「动手前的地图」。读完你应该清楚三件事：现在的 App 是怎么搭的、新原生 UI 怎么调用旧的「大脑」、以及我打算分几步走。每一节都尽量用大白话解释「为什么」，方便后续回看。

---

## 0. 一句话结论

旧 App 其实有**两套 UI**（不止你提到的一套），但**业务逻辑（"大脑"）非常干净、全部可原样复用**。新 UI 用 Kotlin + Compose 重写，关键约束是：**新代码里"碰钱"的那层必须和旧 Java 放在同一个包名 `ai.agentwallet.hd` 里**，否则编译时根本看不到那些类。其余都是常规 MVVM。下面有两个需要你拍板的问题（第 6 节）。

---

## 1. 调研结论（现状盘点）

### 1.1 现在的 App 长什么样：有两套 UI，不是一套

读完 [AndroidManifest.xml](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/AndroidManifest.xml) 后发现，App 里其实注册了**两个界面 Activity**：

| Activity | 角色 | 入口 | 渲染方式 | 行数 |
|---|---|---|---|---|
| [WalletWebActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/WalletWebActivity.java) | **主界面**（你要替换的） | `LAUNCHER`（点图标进的就是它） | WebView 套壳，加载 `assets/web/index.html` | 581 |
| [MainActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/MainActivity.java) | **深链 / 通知处理界面** | `agentwallet://relay`、`velarumpay://pair`、`setup` 等链接，以及点推送通知 | **纯原生 Java 经典 View**（不是 WebView） | 4,895 |

**这点很重要，也是你的简报里没提到的：** `MainActivity` 是一套**已经是原生**的 UI（用老式的 `LinearLayout`/`Button`/底部弹层写的），它自己也有一条完整的发送流程（`executeSend`）。它平时不出现，只有当用户点了付款推送通知、或从外部链接（配对/设置）进来时才弹出。

所以"WebView 套壳"严格说只覆盖了**点图标进入的主界面**。`MainActivity` 的去留，是第 6 节要请你定的问题之一。

> 名词解释：**深链（deep link）**＝点一个特殊链接或通知，直接跳进 App 的某个具体页面，而不是从首页开始。

### 1.2 UI ↔ 逻辑「契约」：这就是 ViewModel 的蓝本

旧的 WebView 通过两个 JS 桥（`NativeBridge`、`ScanBridge`）调用原生逻辑。我把两端都读了：Java 端在 [WalletWebActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/WalletWebActivity.java)，网页端（包括所有回调）在 [app-bridge.js](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/assets/web/app-bridge.js)。这就是「UI 需要逻辑层做哪些事」的**完整清单**，新 ViewModel 一一对应即可（不再需要 JSON 桥，直接调 Java 方法）：

| UI 操作 | 旧桥方法 | 背后调用的逻辑 | 新原生对应 |
|---|---|---|---|
| 是否已有钱包 | `hasWallet()` | `SecureWalletStore.hasWallet` | `repo.hasWallet()` |
| 读取钱包数据（地址/身份/缓存余额） | `walletData()` | `walletStateJson()`（拼地址 + `BalanceStore.cached`） | `repo.loadWalletState()` → `StateFlow` |
| 刷新余额 | `refreshBalances()` | `BalanceFetcher.fetch` + `BalanceStore.save` | `repo.refreshBalances()` |
| 创建钱包 | `createWallet()` | `HDWallet.create` + `SecureWalletStore.save(...,false)` | `repo.createWallet()` |
| 导入助记词 | `importWallet(phrase)` | `HDWallet.restore` + `save(...,true)` | `repo.importWallet(phrase)` |
| 读取助记词 | `mnemonicWords()` | `HDWallet.mnemonicWords` | `repo.mnemonicWords()` |
| 确认已备份 | `confirmBackup()` | `SecureWalletStore.markBackupVerified` | `repo.confirmBackup()` |
| **发送转账** | `send(json)` | 见 1.2.1 的完整管线 | `SendViewModel` + `repo.send(form)` |
| 复制 | `copy` / `copyToClipboard` | 系统剪贴板 | `ClipboardHelper.copy()` |
| 粘贴 | `readClipboard` | 系统剪贴板 | `ClipboardHelper.read()` |
| 扫码 | `ScanBridge.startScan(mode)` | `QrScannerActivity`（返回 `EXTRA_PAYLOAD`） | Activity Result API |

旧的「网页 → 原生」回调（`__vpOnData`、`__vpOnSendResult`、`__vpOnWalletCreated`、`__vpOnBackupDone`、`__vpOnWalletImported`、`__vpOnError`、`VelarumPrototypeScanResult`）在原生里**全部消失**——它们会变成 `StateFlow` 的状态更新或挂起函数（`suspend`）的返回值。这正是从"回调地狱"升级到原生的最大收益。

#### 1.2.1 发送（最关键、当初最痛）的逐步管线

这段「编排」逻辑写在 `WalletWebActivity.NativeBridge.send()` 里（属于 UI 胶水层，不是逻辑类）。我会把它**逐字照搬**进一个 `SendUseCase`，顺序/校验/报错一个都不改：

1. 解析输入：`symbol`、`network`、`to`(去空格)、`amount`(去空格)、`memo`(去空格)。
2. `ensureWalletLoaded()`；若钱包为空 → 报 **"No wallet loaded."**
3. 若 `SecureWalletStore.isBackupVerified` 为否 → 报 **"Back up your recovery phrase first."**，并带 `backupRequired` 标记（UI 引导去备份）。
4. 若 `to` 或 `amount` 为空 → 报 **"Enter a recipient and amount."**
5. `intent = buildLocalSendIntent(...)` —— 严格的 (币种, 网络) 白名单，见下表，**任何未知组合直接抛错**（绝不让交易走错链/错币）。
6. `risk = RiskPolicy.evaluate(ctx, intent)`；若不通过 → 把 `risk.errors` 拼成一句话报出来。
7. **切到主线程**弹生物识别 `BiometricPrompt`（标题 "Send {symbol}"）。
8. 认证**成功** → 后台线程依次：
   1. `tx = PaymentExecutor.execute(ctx, wallet, intent)`（它内部**会再跑一次** `RiskPolicy`，是纵深防御，别省）
   2. `RiskPolicy.recordSuccessfulPayment(ctx, intent)`（把这笔记进"当日已花额度"账本）
   3. `TransactionHistoryStore.record(...)`（失败也不影响主流程，原代码用 try/catch 吞掉）
   4. 回报成功 + `txHash`，然后 `refreshBalances()`
9. 认证**失败/取消** → 报 **"Authentication was cancelled."**

`buildLocalSendIntent` 的白名单（逐字对照，决定 memo / chain_id / decimals 等关键字段）：

| symbol | network | rail | 关键字段 |
|---|---|---|---|
| XLM | 含 "stellar" | `stellar_xlm` | network=`stellar`, `horizon_url` |
| SOL | 含 "solana" | `solana_sol` | network=`solana_mainnet`, decimals=9, `rpc_url` |
| USDC | `base` | `base_usdc` | network=`base_mainnet`, chain_id=8453, token_contract=BASE_USDC, decimals=6 |
| ETH | `base` | `evm_native` | network=`base_mainnet`, chain_id=8453 |
| ETH | `ethereum` | `evm_native` | network=`ethereum`, chain_id=1 |
| POL/MATIC | `polygon` | `evm_native` | network=`polygon`, chain_id=137 |
| 其它任何组合 | — | — | **抛 `IllegalStateException`（不支持）** |

> 顺带说一句：[MainActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/MainActivity.java) 里的 `executeSend` / `buildSendAssetIntent` 是**同一条管线的第二个实现**（注释明确说"和 WebView 共用一条验证→签名→广播管线"）。两处可以互相印证，移植时我会逐字对照两者。

### 1.3 关键技术约束：业务类是「包内私有」，新 Kotlin 必须同包

这是整个改造里**最容易踩坑、必须先讲清**的一点：

几乎所有逻辑类的声明都是 `final class HDWallet`、`final class PaymentExecutor`、`final class RiskPolicy`、`final class SecureWalletStore`……**前面没有 `public`**。在 Java 里这叫「包内私有（package-private）」——意思是：只有**同一个包 `ai.agentwallet.hd`** 里的代码才能看见和调用它们。连 `HDWallet` 的字段 `wallet.evm.privateKey`、`wallet.stellar.privateSeed` 也是包内私有。

后果：

- ✅ **能做到「零改动复用」**：Kotlin 完全可以调用 Java 的包内私有成员，**前提是这个 Kotlin 文件声明自己也在 `package ai.agentwallet.hd`**。
- ❌ 如果我把调用这些类的代码放进 `ai.agentwallet.hd.ui.vm` 这种**子包**，就等于换了个包，编译会直接报「找不到/不可见」——那时唯一的"出路"就是去给 Java 加 `public`，**而这违反你的铁律 1**。

**所以我的方案是**：建一个**很薄的「门面层（Facade / Repository）」放在 `ai.agentwallet.hd` 包里**（和 Java 同包），它对外暴露 `public` 的 Kotlin 方法（参数/返回值都用简单类型或 Kotlin 数据类），内部去调那些包内私有的 Java。然后所有 ViewModel/界面都只依赖这个门面，可以自由放在子包里。这样：

- 业务 Java **一行不改**（满足铁律 1）；
- "碰钱"的胶水集中在一处、好审计；
- UI 层和 Java 细节解耦。

### 1.4 键盘 / edge-to-edge 痛点：根因与原生解法

旧代码为了让 WebView 里的输入框能弹键盘，叠了一堆 hack（见 [WalletWebActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/WalletWebActivity.java) 第 59–82 行的长注释：`WebChromeClient` + `focusableInTouchMode` + `OnTouchListener` 抢焦点），还在主题里写了 `windowOptOutEdgeToEdgeEnforcement=true`（见 [styles.xml](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/res/values/styles.xml)）来"退回旧的键盘顶起行为"。这正是当初最痛的地方。

**原生 Compose 怎么一次做对：**

- 新 Activity 调 `enableEdgeToEdge()`，**不再 opt-out**（即新主题里**不写** `windowOptOutEdgeToEdgeEnforcement`）。
- 内容用 `Scaffold` + `WindowInsets`，输入区域加 `Modifier.imePadding()`（键盘弹出时内容自动让位）和 `Modifier.navigationBarsPadding()`。
- Compose 的 `TextField` 聚焦即弹键盘，天然不存在 WebView 那种"容器抢焦点、页面上跳"的问题。
- 这个改善**必须在真机上验证**（见第 7 节验收）。

> 名词解释：**edge-to-edge（边到边）**＝App 内容铺满整个屏幕（包括状态栏/导航栏底下），由 App 自己负责给内容留出"安全边距"。Android 15（targetSdk 35）强制开启，所以原生必须正确处理，而不是像旧 WebView 那样关掉它。

---

## 2. 迁移计划（分阶段）

### 2.1 渐进式策略：怎样保证「每次提交都能编译、能安装」

你的铁律是"一屏一屏替换、WebView 始终可用、全部对齐后才删 WebView"。这里有个现实问题需要说明：**WebView 和 Compose 是两套完全不同的渲染方式**，没法在"同一个用户流程中间"无缝切换某一屏。所以我把"最小替换单位"定为**一个完整的流程（flow）**。

按你已确认的方式——**开通 + 首页做完即把入口切到原生**——采用「临时 hand-off（交接）」保证不破：

- 新增原生 `MainComposeActivity`。**阶段 0–1 它先不做入口**（图标仍进 WebView），用开发入口边做边测。
- **阶段 2 末（开通 + 首页跑通）把 LAUNCHER 切到 `MainComposeActivity`**。此时还没做的页面（发送/收款/收件箱/设置…）在原生里被点到时，**临时跳回 [WalletWebActivity.java](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/java/ai/agentwallet/hd/WalletWebActivity.java) 的对应屏**（给它传一个 `START_SCREEN` 参数即可，约十几行胶水，且写在即将删除的文件里）。
- 因为 **WebView 整套仍是完整可用的退路**，过渡期用户**不丢任何功能**——连发送都还能用 WebView 那条同样经过 `RiskPolicy → 生物识别 → PaymentExecutor` 的流程；唯一代价是这些未迁移页面在过渡期显示的是网页样式。每迁好一个流程，就把它从 hand-off 名单里去掉。
- 全部页面对齐后，最后一步删除 WebView、`WalletWebActivity`、`assets/web/`，并清理临时 hand-off 与 `windowOptOutEdgeToEdgeEnforcement`。

> 名词解释：**hand-off** ＝原生还没做好的页面，先"交接"回旧 WebView 去显示，保证点哪都有正常画面；做好一个就收回一个。

每个阶段结束都能 `./gradlew assembleDebug` 通过并安装，App 永远不会处于"半崩"状态。

### 2.2 阶段表（对应你给的建议顺序）

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **0. 地基** | Gradle 加 Kotlin + Compose（第 5 节）；建主题（第 4 节）；建门面 `WalletRepository`（1.3）；新建 `MainComposeActivity`（继承 `FragmentActivity`，`enableEdgeToEdge`）。**暂不设为 LAUNCHER。** | `assembleDebug` 通过；旧 WebView 不受影响、仍是入口 |
| **1. 骨架与通用件** | 导航骨架（Navigation-Compose）+ 底部 3 tab（home/inbox/profile）+ 通用 Toast/Modal/ActionBar/按钮/卡片/输入框 | 能在原生里切 3 个空 tab |
| **2. 开通流程 + 切入口** | CreateWallet / KeyImport / KeyBackup / DeviceRisk；**把 LAUNCHER 切到原生 `MainComposeActivity`**，并接上临时 hand-off（未迁移页面跳回 WebView） | 能创建/导入钱包、看到助记词、确认备份；点图标即进原生 |
| **3. 首页 + 收款** | Home / Balance / Assets（含 Customize/Search/Detail/History）/ Receive（二维码） | 能看余额、地址、收款码 |
| **4. 发送 + 人工复核** ⭐ | Send / ManualReview / ManualStatusTracker，**把 1.2.1 的管线逐字移植**；真机验证键盘 | memo/金额输入框聚焦弹键盘、不上跳；发送严格走 RiskPolicy→生物识别→PaymentExecutor→记账 |
| **5. 收件箱 / 详情 / 档案** | Inbox / Detail / Dossier（含 TruthPanel、EvidenceGallery、TransactionStatePanel、MerchantProof、DecisionSnapshot） | 列表/详情/证据面板与旧版一致 |
| **6. 扫码 / 配对 / 代理** | ScanTransfer / ScanModes / Scanned*（Address/Pairing/Setup/External/Invalid）/ Pairing / Agents / AgentDetail | 扫码复用 `QrScannerActivity`，配对走 `RelayClient` |
| **7. 设置类** | Profile / WalletIdentity（昵称/钱包ID/头像）/ Settings / DisplayLanguage / Security / Networks / Notifications / Developer / Activity | 各设置项与旧版一致 |
| **8. 退役 WebView + 收尾 MainActivity** | 删除 WebView、`WalletWebActivity`、`assets/web/` 与临时 hand-off；清 `windowOptOutEdgeToEdgeEnforcement`；按 6.2 的方案 C：把 4 个深链 intent-filter + 通知意图迁到 `MainComposeActivity` 并退役 MainActivity 的 View 代码（单独验证「通知→审核→签名」） | 仅剩单一 Compose UI；单元测试仍全绿 |

> 屏幕清单依据：我从 [index.html](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/assets/web/index.html) 的路由分发表（`render()` 里的 `screens` 映射，共 **28 个路由**）逐一核对，和你简报里的页面列表基本吻合。页面内部的子状态（如 `walletIdentityMode`、`keyBackupStep`、`networkMode`、`manualStatus`）在原生里是 **ViewModel 的 UiState 字段**，不是单独的导航路由。

---

## 3. 包结构 / 文件组织建议

核心原则（来自 1.3）：**"碰钱"和需要包内私有访问的 Kotlin → 放进 `ai.agentwallet.hd` 包；纯 UI → 放子包。**

```
app/src/main/java/ai/agentwallet/hd/
├─ (现有 38 个 Java 逻辑文件 —— 一律不动)
│
├─ MainComposeActivity.kt        # 新 LAUNCHER（继承 FragmentActivity，enableEdgeToEdge）
│                                #  ↑ 同包：因为 BiometricPrompt + 启动 QrScannerActivity 需要
├─ bridge/  → 实际声明 package ai.agentwallet.hd（同包，才能访问包内私有）
│   ├─ WalletRepository.kt        # 门面：hasWallet/loadWalletState/refreshBalances/create/import/...
│   ├─ SendUseCase.kt             # 1.2.1 的发送管线逐字移植（RiskPolicy→生物→Executor→记账）
│   ├─ BiometricAuth.kt           # 封装 BiometricPrompt（同 authenticate 逻辑）
│   └─ ClipboardHelper.kt         # copy / read 剪贴板
│
└─ ui/   （以下都是纯 UI，可放子包，只依赖门面层暴露的 public 类型）
    ├─ theme/      Color.kt · Type.kt · Shape.kt · Spacing.kt · Theme.kt
    ├─ navigation/ VelarumNavHost.kt · Routes.kt
    ├─ components/ VpButton · VpCard · VpTopBar · VpBottomNav · VpToast · VpModal · VpActionBar · VpTextField · VpPill
    ├─ vm/         HomeViewModel · SendViewModel · OnboardingViewModel · InboxViewModel · ScanViewModel · SettingsViewModel ...
    └─ screens/
        ├─ onboarding/  CreateWalletScreen · KeyImportScreen · KeyBackupScreen · DeviceRiskScreen
        ├─ home/        HomeScreen · AssetsScreen · AssetDetailScreen · AssetHistoryScreen · AssetSearchScreen
        ├─ send/        SendScreen · ManualReviewScreen · ManualStatusScreen
        ├─ receive/     ReceiveScreen
        ├─ inbox/       InboxScreen · DetailScreen · DossierScreen
        ├─ scan/        ScanTransferScreen · ScannedResultScreens · PairingScreen
        ├─ agents/      AgentsScreen · AgentDetailScreen
        └─ settings/    ProfileScreen · WalletIdentityScreen · SettingsScreen · SecurityScreen · NetworksScreen · ...
```

> 说明：上面 `bridge/` 是**目录名**，里面的 `.kt` 文件第一行仍写 `package ai.agentwallet.hd`（Kotlin 允许目录名和包名不一致）。这样既能整理文件，又满足同包访问。`ui.vm` 里的 ViewModel 只拿门面层返回的 **Kotlin 数据类/字符串**，不直接碰 `PaymentIntent` 等包内私有类型。

---

## 4. Compose 主题对照表（设计令牌 → Compose 值）

来源：[tokens/](computer:///Users/yang/code/VelarumPayCode/apps/android/app/src/main/assets/web/design-system/VelarumPay-DS-Core/tokens) 下的 `colors.css` / `spacing.css` / `radii.css` / `typography.css` / `shadows.css` / `motion.css`。我会建一套自定义 `VelarumColors`（用 `CompositionLocal` 注入），并把核心色映射到 Material 3 的 `ColorScheme`（避免默认紫色）。

### 4.1 颜色（语义别名 → 十六进制 → Compose）

| 语义角色 | 取值 | Compose |
|---|---|---|
| primary（品牌主色） | green-600 `#2E7D43` | `Color(0xFF2E7D43)` → `ColorScheme.primary` |
| primary 按下/hover | green-700 `#246337` / green-800 `#1C4E2C` | pressed/active 态 |
| primary-soft | green-50 `#ECF5EE` | 浅底/选中底 |
| on-primary | `#FFFFFF` | `ColorScheme.onPrimary` |
| emphasis（黑色箭头胶囊） | stone-900 `#1A1E1A`（hover `#000000`） | 高强调按钮底色 |
| text-strong | stone-900 `#1A1E1A` | 标题/重要文字 |
| text-body | stone-700 `#424840` | 正文 |
| text-muted | stone-500 `#7E867A` | 次要 |
| text-faint | stone-400 `#A6AEA1` | 更弱 |
| surface-page（页面底） | sage-100 `#E7F0DD` | `ColorScheme.background` |
| surface-card | `#FFFFFF` | `ColorScheme.surface` / 卡片 |
| surface-sunken | stone-100 `#EFF2EC` | 凹陷底 |
| surface-inverse | stone-900 `#1A1E1A` | 深色块/黑胶囊 |
| border-subtle / default / strong | stone-200 `#E0E5DC` / stone-300 `#C8CFC3` / stone-400 `#A6AEA1` | 描边 |
| success / bg | green-600 / green-50 `#ECF5EE` | 成功状态 |
| pending / bg | amber-500 `#DDA52B` / amber-100 `#FBF1D8` | 处理中 |
| failed / bg（error） | red-500 `#CD4A3E` / red-100 `#FAE3E0` | `ColorScheme.error` / 错误 |
| info / bg | blue-500 `#3E78A6` / blue-100 `#E1ECF4` | 信息 |
| risk-safe/caution/danger | 同 success / pending / failed | 风控等级 |
| focus-ring | `rgba(46,125,67,0.32)` | 聚焦描边 |

### 4.2 间距（4px 基准网格 → dp）

`--space-1`=4dp，`-2`=8，`-3`=12，`-4`=16，`-5`=20，`-6`=24，`-8`=32，`-10`=40，`-12`=48，`-16`=64，`-20`=80，`-24`=96，`-32`=128。

控件高度：`control-h-sm`=36dp、`-md`=44dp（触控最小命中区）、`-lg`=52dp。
专属高度：底部导航 `--nav-h`=**78dp**、底部主操作栏 `--action-h`=**92dp**。

→ 建一个 `object Spacing { val s1=4.dp; ... }` 统一引用。

### 4.3 圆角（→ `Shape.kt`）

| 令牌 | 值 | Compose |
|---|---|---|
| radius-xs | 6px | `RoundedCornerShape(6.dp)` |
| radius-sm | 10px | `RoundedCornerShape(10.dp)` |
| radius-md | 14px | `RoundedCornerShape(14.dp)` |
| radius-lg | 20px | `RoundedCornerShape(20.dp)` |
| radius-xl | 28px（**主卡片**） | `RoundedCornerShape(28.dp)` |
| radius-2xl | 36px | `RoundedCornerShape(36.dp)` |
| radius-pill | 999px（按钮/标签） | `RoundedCornerShape(50)`（百分比，自动半圆端） |
| radius-circle | 50% | `CircleShape` |

### 4.4 字体与字号（→ `Type.kt`）

字体家族（注意：`fonts.css` 说明这些是 **Google Fonts 替代品**，仓库里没有授权的二进制字体）：

- Display 标题：**Quicksand**
- UI / 正文：**Hanken Grotesk**
- 等宽（地址/金额）：**JetBrains Mono**

→ 原生需要把这三种字体作为资源加进来（放 `res/font/` 用 `FontFamily`，或用 Google Fonts 可下载字体 provider）。**这是阶段 0 的一个小任务，我会在实现时处理；若你已有授权字体二进制，给我即可替换。**

字号（16px 为根，1rem=16）：xs 12sp、sm 13sp、base **15sp（UI 默认）**、md 17sp、lg 20sp、xl 24sp、2xl 30sp、3xl 38sp、4xl 48sp、5xl 60sp、6xl 76sp。
字重：regular 400 / medium 500 / semibold 600 / bold 700。
行高：tight 1.15 / snug 1.3 / normal 1.5 / relaxed 1.65。
字距：tighter -0.02em / tight -0.01em / wide 0.04em / wider 0.12em（大写小标签 eyebrow）。

### 4.5 阴影与动效

- 阴影：CSS 用的是多层柔和低透明阴影（如 `--shadow-card`）。Compose 的阴影模型不同，用 `Modifier.shadow(elevation, shape, ambientColor=…, spotColor=…)` 近似即可——**视觉近似而非像素逐点复刻**（这点 Compose 与 CSS 本就难 1:1）。
- 动效：时长 fast 120ms / base 200ms / slow 320ms → `tween(120/200/320)`；缓动 `cubic-bezier(0.4,0,0.2,1)` 等 → `CubicBezierEasing(...)`；按下缩放 `--press-scale: 0.98` → 点击态 `scale(0.98)`。

---

## 5. 需要新增的 Gradle 依赖与版本

已核对当前工具链（来自 [app/build.gradle](computer:///Users/yang/code/VelarumPayCode/apps/android/app/build.gradle) 与 gradle wrapper）：**AGP 8.7.3、Gradle 8.9、compileSdk 35、minSdk 26、Java 17、已开 desugaring**。据 Android 官方兼容表，AGP 8.7 对应 Gradle 8.9 + JDK 17（与现状完全吻合），且 **AGP 8.7.3 推荐搭配 Kotlin 2.1**。自 Kotlin 2.0 起，Compose 编译器随 Kotlin 同版本发布，用 `org.jetbrains.kotlin.plugin.compose` 插件引入（**不再需要老式的 `kotlinCompilerExtensionVersion`**）。

为**不被迫升级 compileSdk 36**（你的约束是保持 35），我选用仍稳定支持 compileSdk 35 的那一代版本：

| 用途 | 依赖 / 插件 | 版本 |
|---|---|---|
| Kotlin 插件 | `org.jetbrains.kotlin.android` | **2.1.0** |
| Compose 编译器插件 | `org.jetbrains.kotlin.plugin.compose` | **2.1.0**（须与 Kotlin 同版本） |
| Compose 物料清单 | `androidx.compose:compose-bom` | **2025.01.01**（compileSdk 35 安全；更新的 BOM 可能要求 36） |
| Compose UI（版本由 BOM 管） | `androidx.compose.ui:ui`、`ui-graphics`、`ui-tooling-preview` | 跟 BOM |
| Material 3 | `androidx.compose.material3:material3` | 跟 BOM |
| 图标（可选） | `androidx.compose.material:material-icons-extended` | 跟 BOM |
| 预览/调试 | `androidx.compose.ui:ui-tooling`（`debugImplementation`） | 跟 BOM |
| Activity + edge-to-edge | `androidx.activity:activity-compose` | **1.9.3** |
| 导航 | `androidx.navigation:navigation-compose` | **2.8.5** |
| ViewModel for Compose | `androidx.lifecycle:lifecycle-viewmodel-compose` | **2.8.7** |
| 生命周期感知收集 | `androidx.lifecycle:lifecycle-runtime-compose` | **2.8.7** |
| 已有，不动 | `androidx.biometric:biometric` | 1.1.0 |

具体改动（Groovy DSL）：

- **根 [build.gradle](computer:///Users/yang/code/VelarumPayCode/apps/android/build.gradle)** plugins 里增加（`apply false`）：`org.jetbrains.kotlin.android` 2.1.0、`org.jetbrains.kotlin.plugin.compose` 2.1.0。
- **[app/build.gradle](computer:///Users/yang/code/VelarumPayCode/apps/android/app/build.gradle)**：plugins 应用上述两个插件；`android { buildFeatures { compose true } }`；加 `kotlinOptions { jvmTarget = "17" }`（与已有 Java 17 一致）；`dependencies` 加上表条目（用 `platform(...)` 引 BOM）。
- **[settings.gradle](computer:///Users/yang/code/VelarumPayCode/apps/android/settings.gradle)** 无需改（已含 `google()` / `mavenCentral()` / `gradlePluginPortal()`）。
- **新主题**：给 `MainComposeActivity` 一个不含 `windowOptOutEdgeToEdgeEnforcement` 的主题（如 `Theme.Velarum.Compose`），让原生正确处理 edge-to-edge；旧 `WalletWebActivity` 继续用现有 `AppTheme`（带 opt-out）直到退役。

> 这些版本都经过交叉核对，与 compileSdk 35 / AGP 8.7.3 / Gradle 8.9 / Java 17 兼容；都不强制升 compileSdk。若你愿意升 compileSdk 36，可换更新的 BOM/库，但那会多动构建配置，默认不做。

---

## 6. 已确认的决策 + MainActivity 深入分析

### 6.1 你已确认：入口尽早切到原生

**开通 + 首页（阶段 2）做完后，就把 LAUNCHER 切到原生。** 落地办法见 2.1 的「临时 hand-off」：未迁移的页面被点到时临时跳回 WebView——功能不丢（WebView 仍是完整可用的退路，发送也照走同一条风控/签名管线），过渡期这些页面只是网页样式，每迁好一个就收回一个。

### 6.2 MainActivity 怎么办：分析与建议

**先弄清它到底是什么**（别误判）：它是一套**已经写好的、完整的原生 Java 经典 View 钱包 UI**（钱包/消息/历史/设置四个 tab + 一堆底部弹层，含自己的 `executeSend`）。它**不是图标入口**，只在两种情况出现：

1. 点付款类**推送通知**（`RelayPushService` → 通知 → `MainActivity.openPaymentIntentFromNotification`）；
2. 走**深链** `agentwallet://relay | configure-relay | setup`、`velarumpay://pair`。

关键事实：**WebView 主界面并不处理这些深链/通知，只有 MainActivity 处理。** 所以即便把 WebView 全换成 Compose，"代理付款通知 / 配对"这条入口今天仍然依赖 MainActivity——而这正是产品的核心价值路径（agent 发起付款 → 用户审核签名），**越早动它风险越高，且收益不急**。

三个选项权衡：

| 方案 | 好处 | 代价 / 风险 |
|---|---|---|
| A 全程不动 | 通知/深链/relay 零风险，专注换 WebView | 终局有**两套不同风格**原生 UI（点通知弹的是旧式 View，与新 Compose 不一致）；两条 send 并存 |
| B 早期就并入 | 早统一 | 过早触碰通知/付款核心路径，风险最高、收益不急 |
| **C（推荐）设计向 B、执行放最后** | 拿到"单一 Compose UI、可删 MainActivity 4,895 行"的干净终局，又不在前期担风险 | 终局阶段需仔细验证"通知→审核→签名"在 Compose 的等价实现 |

**我推荐 C**，理由：

1. 阶段 5–6 我们**本来就要**在 Compose 里实现 Inbox / Detail / Dossier / Pairing / Agents（WebView 也有这些页）。它们正是 MainActivity 通知/深链流程要落地的目标页——**直接复用**。于是 B 的增量主要只剩"把 4 个深链 intent-filter + 通知意图指向 `MainComposeActivity`，并把 `PaymentNotifications` / `RelayPushService` 的目标 Activity 改过去"。
2. 因此 **阶段 0–7 完全不碰 MainActivity**（＝拿到 A 的安全性：每次提交都能装、核心付款路径走久经考验的旧码）。
3. **阶段 8（终局清理）** 再把深链 + 通知入口迁到 `MainComposeActivity`、路由进已建好的 Compose 页面 → 充分验证 → 与 WebView 一起退役 MainActivity 的 View 代码。
4. **保留刹车**：到阶段 8 时若你更想稳，可停在 A（MainActivity 原样留着当兜底），终局再定。注意：迁移这条入口会**修改** `PaymentNotifications` / `RelayPushService` 指向的 Activity——属于"UI 入口接线"而非业务逻辑改写，但因涉及核心付款路径，我会**单独成阶段、重点验证，动手前再跟你确认一次**。

---

## 7. 验收对照（呼应你的标准）

- ✅ **键盘**：Send 的 memo/金额框聚焦弹键盘、输入流畅、点击不上跳 → 靠 `enableEdgeToEdge` + `imePadding` + 原生 `TextField`，**真机验证**。
- ✅ **视觉一致**：严格按第 4 节令牌还原配色/间距/圆角。
- ✅ **发送管线**：逐字照搬 1.2.1，严格 `RiskPolicy → 生物识别 → PaymentExecutor → 记账`。
- ✅ **始终可编译可安装**：见 2.1 渐进策略。
- ✅ **单元测试保持通过**：现有 `app/src/test` 全是逻辑测试（不依赖 UI），改造不碰逻辑，理应全绿；每阶段我会跑 `./gradlew test`。
- ✅ **iOS 与业务 Java 零改动**：除非你在第 6 节另行同意。

---

**下一步**：请你（1）确认第 6 节两个问题，（2）认可这份计划。确认后我从**阶段 0（地基）**开始，做完即给你 `assembleDebug` 结果和真机测试方法，再逐流程推进。
