package ai.agentwallet.hd.ui

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import androidx.navigation.compose.NavHost
import ai.agentwallet.hd.ui.navigation.screen
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ai.agentwallet.hd.AppEntry
import ai.agentwallet.hd.ScanContract
import ai.agentwallet.hd.ScanOutcome
import ai.agentwallet.hd.SettingsRepository
import ai.agentwallet.hd.ui.components.LocalModalController
import ai.agentwallet.hd.ui.components.LocalToastController
import ai.agentwallet.hd.ui.components.ModalController
import ai.agentwallet.hd.ui.components.ToastController
import ai.agentwallet.hd.ui.components.VpBottomNav
import ai.agentwallet.hd.ui.components.VpModalHost
import ai.agentwallet.hd.ui.components.VpToastHost
import ai.agentwallet.hd.ui.navigation.Routes
import ai.agentwallet.hd.ui.navigation.appEnter
import ai.agentwallet.hd.ui.navigation.appExit
import ai.agentwallet.hd.ui.navigation.appPopEnter
import ai.agentwallet.hd.ui.navigation.appPopExit
import ai.agentwallet.hd.ui.wallet.ActivityScreen
import ai.agentwallet.hd.ui.wallet.ActivityViewModel
import ai.agentwallet.hd.ui.wallet.AgentDetailScreen
import ai.agentwallet.hd.ui.wallet.AgentDetailViewModel
import ai.agentwallet.hd.ui.wallet.AgentsScreen
import ai.agentwallet.hd.ui.wallet.AgentsViewModel
import ai.agentwallet.hd.ui.wallet.ConnectKeyScreen
import ai.agentwallet.hd.ui.wallet.ConnectKeyViewModel
import ai.agentwallet.hd.ui.wallet.AssetCustomizeScreen
import ai.agentwallet.hd.ui.wallet.AssetDetailScreen
import ai.agentwallet.hd.ui.wallet.AssetHistoryScreen
import ai.agentwallet.hd.ui.wallet.AssetSearchScreen
import ai.agentwallet.hd.ui.wallet.DetailScreen
import ai.agentwallet.hd.ui.wallet.DetailViewModel
import ai.agentwallet.hd.ui.wallet.DeveloperScreen
import ai.agentwallet.hd.ui.wallet.DeveloperViewModel
import ai.agentwallet.hd.ui.wallet.DisplayLanguageScreen
import ai.agentwallet.hd.ui.wallet.DossierScreen
import ai.agentwallet.hd.ui.wallet.HomeScreen
import ai.agentwallet.hd.ui.wallet.IdentityViewModel
import ai.agentwallet.hd.ui.wallet.InboxScreen
import ai.agentwallet.hd.ui.wallet.InboxViewModel
import ai.agentwallet.hd.ui.wallet.NetworksScreen
import ai.agentwallet.hd.ui.wallet.NetworksViewModel
import ai.agentwallet.hd.ui.wallet.NotificationsScreen
import ai.agentwallet.hd.ui.wallet.PairingScreen
import ai.agentwallet.hd.ui.wallet.PairingViewModel
import ai.agentwallet.hd.ui.wallet.ProfileScreen
import ai.agentwallet.hd.ui.wallet.ReceiveScreen
import ai.agentwallet.hd.ui.wallet.SecurityScreen
import ai.agentwallet.hd.ui.wallet.SendScreen
import ai.agentwallet.hd.ui.wallet.SendViewModel
import ai.agentwallet.hd.ui.wallet.SettingsScreen
import ai.agentwallet.hd.ui.wallet.WalletIdentityScreen
import ai.agentwallet.hd.ui.wallet.WalletViewModel

/**
 * 原生主界面（全部原生，无 WebView hand-off）。Scaffold + 底部导航 + NavHost + Toast/Modal 宿主。
 */
@Composable
fun VelarumApp(entry: AppEntry = AppEntry.None, onEntryHandled: () -> Unit = {}) {
    val navController = rememberNavController()
    val toastController = remember { ToastController() }
    val modalController = remember { ModalController() }
    val walletVm: WalletViewModel = viewModel()
    val sendVm: SendViewModel = viewModel()
    val inboxVm: InboxViewModel = viewModel()
    val detailVm: DetailViewModel = viewModel()
    val agentsVm: AgentsViewModel = viewModel()
    val agentDetailVm: AgentDetailViewModel = viewModel()
    val pairingVm: PairingViewModel = viewModel()
    val connectKeyVm: ConnectKeyViewModel = viewModel()
    val identityVm: IdentityViewModel = viewModel()
    val networksVm: NetworksViewModel = viewModel()
    val activityVm: ActivityViewModel = viewModel()
    val developerVm: DeveloperViewModel = viewModel()
    val context = LocalContext.current
    var pendingPairingCode by remember { mutableStateOf("") }
    val scanLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            when (val outcome = ScanContract.classify(ScanContract.payloadOf(result.data))) {
                is ScanOutcome.Pairing -> {
                    pendingPairingCode = outcome.code
                    navController.navigate(Routes.PAIRING)
                }
                is ScanOutcome.Transfer -> {
                    sendVm.prefill(outcome.symbol, outcome.network, outcome.recipient, outcome.amount, outcome.memo)
                    navController.navigate(Routes.SEND)
                }
                ScanOutcome.Unknown -> toastController.show("Scan", "Unrecognized QR code.")
            }
        }
    }
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route ?: Routes.HOME
    val lifecycleOwner = LocalLifecycleOwner.current

    // ActivityViewModel is app-scoped, so its init-time snapshot becomes stale after a
    // transfer made in the same process. Reload whenever the history route becomes visible;
    // TransactionHistoryStore is local and inexpensive, and chain-success records then appear
    // immediately without requiring an app restart.
    LaunchedEffect(currentRoute) {
        if (currentRoute == Routes.ACTIVITY || currentRoute.startsWith(Routes.ASSET_HISTORY)) {
            activityVm.reload()
        }
    }

    // Refresh immediately whenever a balance-bearing screen becomes visible, again whenever
    // the app returns to the foreground, and periodically while that screen stays resumed.
    // This closes the stale-zero path where the first lookup happened before an account was
    // funded and the old inactive result then survived indefinitely.
    LaunchedEffect(lifecycleOwner, currentRoute) {
        val showsBalances = currentRoute == Routes.HOME ||
            currentRoute == Routes.RECEIVE ||
            currentRoute.startsWith(Routes.ASSET_DETAIL)
        if (!showsBalances) return@LaunchedEffect
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                // The ViewModel already performs the cold-start request. Avoid immediately
                // queueing a duplicate while that request is still loading or refreshing.
                if (!walletVm.ui.value.loading && !walletVm.ui.value.refreshing) {
                    walletVm.refresh()
                }
                delay(60_000L)
            }
        }
    }

    // 通知/深链入口路由（退役 MainActivity 后由原生接住）。
    LaunchedEffect(entry) {
        when (entry) {
            is AppEntry.OpenPayment -> navController.navigate("${Routes.DETAIL}/${entry.intentId}")
            is AppEntry.OpenConnectInvitation -> {
                connectKeyVm.load(entry.invitationId)
                navController.navigate(Routes.CONNECT_KEY)
            }
            is AppEntry.DeepLink -> {
                val outcome = ScanContract.classify(entry.uri)
                if (outcome is ScanOutcome.Pairing) {
                    pendingPairingCode = outcome.code
                    navController.navigate(Routes.PAIRING)
                } else {
                    val url = withContext(Dispatchers.IO) { SettingsRepository.applyRelayConfigLink(context, entry.uri) }
                    if (url != null) {
                        toastController.show("Relay configured", url)
                        navController.navigate(Routes.DEVELOPER)
                    }
                }
            }
            AppEntry.None -> {}
        }
        if (entry !is AppEntry.None) onEntryHandled()
    }

    CompositionLocalProvider(
        LocalToastController provides toastController,
        LocalModalController provides modalController,
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            contentWindowInsets = WindowInsets(0.dp, 0.dp, 0.dp, 0.dp),
            bottomBar = {
                if (currentRoute in Routes.topLevel) {
                    VpBottomNav(
                        currentRoute = currentRoute,
                        onSelect = { route ->
                            navController.navigate(route) {
                                popUpTo(Routes.HOME) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                    )
                }
            },
        ) { innerPadding ->
            Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
                NavHost(
                    navController = navController,
                    startDestination = Routes.HOME,
                    enterTransition = { appEnter() },
                    exitTransition = { appExit() },
                    popEnterTransition = { appPopEnter() },
                    popExitTransition = { appPopExit() },
                ) {
                    screen(Routes.HOME) {
                        HomeScreen(
                            vm = walletVm,
                            onSend = { sendVm.reset(); navController.navigate(Routes.SEND) },
                            onReceive = { navController.navigate(Routes.RECEIVE) },
                            onScan = { scanLauncher.launch(ScanContract.intent(context)) },
                            onSearch = { navController.navigate(Routes.ASSET_SEARCH) },
                            onAdd = { navController.navigate(Routes.ASSET_CUSTOMIZE) },
                            onAssetClick = { key -> navController.navigate("${Routes.ASSET_DETAIL}/$key") },
                        )
                    }
                    screen(Routes.RECEIVE) {
                        ReceiveScreen(vm = walletVm, onBack = { navController.popBackStack() })
                    }
                    screen(Routes.SEND) {
                        SendScreen(
                            vm = sendVm,
                            onExit = { navController.popBackStack() },
                            onFinishToHome = { navController.popBackStack(Routes.HOME, inclusive = false) },
                            onBalanceRefresh = { walletVm.refresh() },
                        )
                    }
                    screen("${Routes.ASSET_DETAIL}/{key}") { entry ->
                        AssetDetailScreen(
                            vm = walletVm,
                            assetKey = entry.arguments?.getString("key") ?: "",
                            onBack = { navController.popBackStack() },
                            onSend = { symbol, network ->
                                sendVm.prefill(symbol, network, "", "", "")
                                navController.navigate(Routes.SEND)
                            },
                            onReceive = { navController.navigate(Routes.RECEIVE) },
                            onHistory = { symbol -> navController.navigate("${Routes.ASSET_HISTORY}/$symbol") },
                        )
                    }
                    screen(Routes.ASSET_SEARCH) {
                        AssetSearchScreen(onBack = { navController.popBackStack() }, onOpen = { key -> navController.navigate("${Routes.ASSET_DETAIL}/$key") })
                    }
                    screen(Routes.ASSET_CUSTOMIZE) {
                        AssetCustomizeScreen(vm = walletVm, onBack = { navController.popBackStack() })
                    }
                    screen("${Routes.ASSET_HISTORY}/{symbol}") { entry ->
                        AssetHistoryScreen(vm = activityVm, symbol = entry.arguments?.getString("symbol") ?: "", onBack = { navController.popBackStack() })
                    }
                    screen(Routes.INBOX) {
                        InboxScreen(vm = inboxVm, onOpen = { id -> navController.navigate("${Routes.DETAIL}/$id") })
                    }
                    screen("${Routes.DETAIL}/{intentId}") { entry ->
                        DetailScreen(
                            vm = detailVm,
                            intentId = entry.arguments?.getString("intentId") ?: "",
                            onBack = { navController.popBackStack() },
                            onDossier = { navController.navigate(Routes.DOSSIER) },
                            onResolved = {
                                inboxVm.reload()
                                walletVm.refresh()
                                navController.popBackStack(Routes.INBOX, inclusive = false)
                            },
                        )
                    }
                    screen(Routes.DOSSIER) {
                        DossierScreen(vm = detailVm, onBack = { navController.popBackStack() })
                    }
                    screen(Routes.AGENTS) {
                        AgentsScreen(
                            vm = agentsVm,
                            onBack = { navController.popBackStack() },
                            onOpen = { id -> navController.navigate("${Routes.AGENT_DETAIL}/$id") },
                            onCreateConnectKey = {
                                connectKeyVm.reset()
                                navController.navigate(Routes.CONNECT_KEY)
                            },
                        )
                    }
                    screen("${Routes.AGENT_DETAIL}/{id}") { entry ->
                        AgentDetailScreen(
                            vm = agentDetailVm,
                            connectionId = entry.arguments?.getString("id") ?: "",
                            onBack = { navController.popBackStack() },
                            onRevoked = { agentsVm.reload(); navController.popBackStack(Routes.AGENTS, inclusive = false) },
                        )
                    }
                    screen(Routes.PAIRING) {
                        PairingScreen(
                            vm = pairingVm,
                            presetCode = pendingPairingCode,
                            onBack = { navController.popBackStack() },
                            onDone = { pendingPairingCode = ""; agentsVm.reload(); navController.popBackStack(Routes.HOME, inclusive = false) },
                        )
                    }
                    screen(Routes.CONNECT_KEY) {
                        ConnectKeyScreen(
                            vm = connectKeyVm,
                            onBack = { navController.popBackStack() },
                            onReviewAgent = { pairingSessionId ->
                                pendingPairingCode = pairingSessionId
                                navController.navigate(Routes.PAIRING)
                            },
                        )
                    }
                    screen(Routes.PROFILE) {
                        ProfileScreen(
                            vm = identityVm,
                            onIdentity = { navController.navigate(Routes.WALLET_IDENTITY) },
                            onAgents = { navController.navigate(Routes.AGENTS) },
                            onActivity = { navController.navigate(Routes.ACTIVITY) },
                            onDeveloper = { navController.navigate(Routes.DEVELOPER) },
                            onSettings = { navController.navigate(Routes.SETTINGS) },
                        )
                    }
                    screen(Routes.WALLET_IDENTITY) {
                        WalletIdentityScreen(
                            vm = identityVm,
                            onBack = { navController.popBackStack() },
                            onSaved = { identityVm.load(); walletVm.refresh(); navController.popBackStack() },
                        )
                    }
                    screen(Routes.SETTINGS) {
                        SettingsScreen(
                            onBack = { navController.popBackStack() },
                            onSecurity = { navController.navigate(Routes.SECURITY) },
                            onNetworks = { navController.navigate(Routes.NETWORKS) },
                            onNotifications = { navController.navigate(Routes.NOTIFICATIONS) },
                            onDisplayLanguage = { navController.navigate(Routes.DISPLAY_LANGUAGE) },
                            onDeveloper = { navController.navigate(Routes.DEVELOPER) },
                            onActivity = { navController.navigate(Routes.ACTIVITY) },
                        )
                    }
                    screen(Routes.SECURITY) { SecurityScreen(onBack = { navController.popBackStack() }) }
                    screen(Routes.DISPLAY_LANGUAGE) { DisplayLanguageScreen(onBack = { navController.popBackStack() }) }
                    screen(Routes.NOTIFICATIONS) { NotificationsScreen(onBack = { navController.popBackStack() }) }
                    screen(Routes.NETWORKS) { NetworksScreen(vm = networksVm, onBack = { navController.popBackStack() }) }
                    screen(Routes.ACTIVITY) { ActivityScreen(vm = activityVm, onBack = { navController.popBackStack() }) }
                    screen(Routes.DEVELOPER) {
                        DeveloperScreen(vm = developerVm, onBack = { navController.popBackStack() }, onPair = { navController.navigate(Routes.PAIRING) })
                    }
                }
                VpToastHost(toastController)
                VpModalHost(modalController)
            }
        }
    }
}
