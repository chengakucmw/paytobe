package ai.agentwallet.hd.ui.navigation

/**
 * 导航路由表。对照旧 WebView 的 state.screen + render() 分发表。
 * 后续阶段在此追加 send / receive / detail 等路由。
 */
object Routes {
    // 底部三 tab（顶层路由）
    const val HOME = "home"
    const val INBOX = "inbox"
    const val PROFILE = "profile"

    // 从 Home 进入的二级页（无底部导航）
    const val RECEIVE = "receive"
    const val SEND = "send"
    const val MANUAL_REVIEW = "manualReview"
    const val ASSET_DETAIL = "assetDetail"
    const val ASSET_SEARCH = "assetSearch"
    const val ASSET_CUSTOMIZE = "assetCustomize"
    const val ASSET_HISTORY = "assetHistory"
    const val DETAIL = "detail"
    const val DOSSIER = "dossier"
    const val AGENTS = "agents"
    const val AGENT_DETAIL = "agentDetail"
    const val PAIRING = "pairing"

    // 设置簇（从 Profile 进入，无底部导航）
    const val WALLET_IDENTITY = "walletIdentity"
    const val SETTINGS = "settings"
    const val SECURITY = "security"
    const val NETWORKS = "networks"
    const val NOTIFICATIONS = "notifications"
    const val DEVELOPER = "developer"
    const val DISPLAY_LANGUAGE = "displayLanguage"
    const val ACTIVITY = "activity"

    // 开通流程（无底部导航）
    const val CREATE_WALLET = "createWallet"
    const val KEY_IMPORT = "keyImport"
    const val KEY_BACKUP = "keyBackup"
    const val DEVICE_RISK = "deviceRisk"

    /** 只有处于这些顶层路由时才显示底部导航（对照 web 的 showBottomNav）。 */
    val topLevel = setOf(HOME, INBOX, PROFILE)
}
