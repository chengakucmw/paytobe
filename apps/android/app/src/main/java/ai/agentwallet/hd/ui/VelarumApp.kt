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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
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
import ai.agentwallet.hd.ui.wallet.ActivityScreen
import ai.agentwallet.hd.ui.wallet.ActivityViewModel
import ai.agentwallet.hd.ui.wallet.AgentDetailScreen
import ai.agentwallet.hd.ui.wallet.AgentDetailViewModel
import ai.agentwallet.hd.ui.wallet.AgentsScreen
import ai.agentwallet.hd.ui.wallet.AgentsViewModel
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

    // 通知/深链入口路由（退役 MainActivity 后由原生接住）。
    LaunchedEffect(entry) {
        when (entry) {
            is AppEntry.OpenPayment -> navController.navigate("${Routes.DETAIL}/${entry.intentId}")
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
                NavHost(navController = navController, startDestination = Routes.HOME) {
                    composable(Routes.HOME) {
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
                    composable(Routes.RECEIVE) {
                        ReceiveScreen(vm = walletVm, onBack = { navController.popBackStack() })
                    }
                    composable(Routes.SEND) {
                        SendScreen(
                            vm = sendVm,
                            onExit = { navController.popBackStack() },
                            onFinishToHome = { navController.popBackStack(Routes.HOME, inclusive = false) },
                            onBalanceRefresh = { walletVm.refresh() },
                        )
                    }
                    composable("${Routes.ASSET_DETAIL}/{key}") { entry ->
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
                    composable(Routes.ASSET_SEARCH) {
                        AssetSearchScreen(onBack = { navController.popBackStack() }, onOpen = { key -> navController.navigate("${Routes.ASSET_DETAIL}/$key") })
                    }
                    composable(Routes.ASSET_CUSTOMIZE) {
                        AssetCustomizeScreen(vm = walletVm, onBack = { navController.popBackStack() })
                    }
                    composable("${Routes.ASSET_HISTORY}/{symbol}") { entry ->
                        AssetHistoryScreen(vm = activityVm, symbol = entry.arguments?.getString("symbol") ?: "", onBack = { navController.popBackStack() })
                    }
                    composable(Routes.INBOX) {
                        InboxScreen(vm = inboxVm, onOpen = { id -> navController.navigate("${Routes.DETAIL}/$id") })
                    }
                    composable("${Routes.DETAIL}/{intentId}") { entry ->
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
                    composable(Routes.DOSSIER) {
                        DossierScreen(vm = detailVm, onBack = { navController.popBackStack() })
                    }
                    composable(Routes.AGENTS) {
                        AgentsScreen(vm = agentsVm, onBack = { navController.popBackStack() }, onOpen = { id -> navController.navigate("${Routes.AGENT_DETAIL}/$id") })
                    }
                    composable("${Routes.AGENT_DETAIL}/{id}") { entry ->
                        AgentDetailScreen(
                            vm = agentDetailVm,
                            connectionId = entry.arguments?.getString("id") ?: "",
                            onBack = { navController.popBackStack() },
                            onRevoked = { agentsVm.reload(); navController.popBackStack(Routes.AGENTS, inclusive = false) },
                        )
                    }
                    composable(Routes.PAIRING) {
                        PairingScreen(
                            vm = pairingVm,
                            presetCode = pendingPairingCode,
                            onBack = { navController.popBackStack() },
                            onDone = { pendingPairingCode = ""; agentsVm.reload(); navController.popBackStack(Routes.HOME, inclusive = false) },
                        )
                    }
                    composable(Routes.PROFILE) {
                        ProfileScreen(
                            vm = identityVm,
                            onIdentity = { navController.navigate(Routes.WALLET_IDENTITY) },
                            onAgents = { navController.navigate(Routes.AGENTS) },
                            onActivity = { navController.navigate(Routes.ACTIVITY) },
                            onDeveloper = { navController.navigate(Routes.DEVELOPER) },
                            onSettings = { navController.navigate(Routes.SETTINGS) },
                        )
                    }
                    composable(Routes.WALLET_IDENTITY) {
                        WalletIdentityScreen(
                            vm = identityVm,
                            onBack = { navController.popBackStack() },
                            onSaved = { identityVm.load(); walletVm.refresh(); navController.popBackStack() },
                        )
                    }
                    composable(Routes.SETTINGS) {
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
                    composable(Routes.SECURITY) { SecurityScreen(onBack = { navController.popBackStack() }) }
                    composable(Routes.DISPLAY_LANGUAGE) { DisplayLanguageScreen(onBack = { navController.popBackStack() }) }
                    composable(Routes.NOTIFICATIONS) { NotificationsScreen(onBack = { navController.popBackStack() }) }
                    composable(Routes.NETWORKS) { NetworksScreen(vm = networksVm, onBack = { navController.popBackStack() }) }
                    composable(Routes.ACTIVITY) { ActivityScreen(vm = activityVm, onBack = { navController.popBackStack() }) }
                    composable(Routes.DEVELOPER) {
                        DeveloperScreen(vm = developerVm, onBack = { navController.popBackStack() }, onPair = { navController.navigate(Routes.PAIRING) })
                    }
                }
                VpToastHost(toastController)
                VpModalHost(modalController)
            }
        }
    }
}
