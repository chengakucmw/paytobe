package ai.agentwallet.hd.ui.wallet

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.agentwallet.hd.WalletRepository
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpFactRow
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumRadii
import ai.agentwallet.hd.ui.theme.VelarumTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val REVEAL_TIMEOUT_MS = 60_000L

/**
 * Re-displays the locally encrypted recovery phrase after explicit device authentication.
 * The phrase never leaves process memory, is cleared on backgrounding, and is not copyable.
 */
@Composable
fun RecoveryPhraseScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val activity = context as FragmentActivity
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    var words by remember { mutableStateOf(emptyList<String>()) }
    var loading by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var revealGeneration by remember { mutableIntStateOf(0) }

    DisposableEffect(lifecycleOwner) {
        val window = (context as? Activity)?.window
        window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) {
                revealGeneration += 1
                words = emptyList()
                loading = false
                message = "Recovery phrase hidden. Authenticate again to view it."
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            words = emptyList()
            lifecycleOwner.lifecycle.removeObserver(observer)
            window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    LaunchedEffect(words) {
        if (words.isNotEmpty()) {
            delay(REVEAL_TIMEOUT_MS)
            words = emptyList()
            message = "Recovery phrase hidden after 60 seconds."
        }
    }

    fun authenticateAndReveal() {
        if (loading) return
        message = null
        BiometricAuth.authenticate(
            activity = activity,
            title = "View recovery phrase",
            subtitle = "Confirm your identity to view the phrase on this device",
            onSuccess = {
                val requestGeneration = revealGeneration + 1
                revealGeneration = requestGeneration
                loading = true
                scope.launch {
                    val loaded = withContext(Dispatchers.IO) {
                        runCatching { WalletRepository.mnemonicWords(context) }.getOrDefault(emptyList())
                    }
                    loading = false
                    val canDisplay = canDisplayRecoveryPhrase(
                        authenticationSucceeded = true,
                        appResumed = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
                        generationMatches = revealGeneration == requestGeneration,
                        wordsPresent = loaded.isNotEmpty(),
                    )
                    if (!canDisplay) {
                        words = emptyList()
                        message = if (loaded.isEmpty()) {
                            "Recovery phrase is unavailable. Lock the app and try again."
                        } else {
                            "Recovery phrase hidden. Authenticate again to view it."
                        }
                    } else {
                        words = loaded
                    }
                }
            },
            onFailure = {
                words = emptyList()
                loading = false
                message = "Authentication was cancelled or failed."
            },
        )
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Security", title = "Recovery phrase", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpRiskBanner(
                VpTone.DANGER,
                "Anyone with these words controls the wallet",
                "Make sure nobody can see your screen. Never screenshot, copy, upload, or send the phrase.",
            )

            if (words.isEmpty()) {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Text("Protected by device authentication", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                    Spacer(Modifier.padding(top = Spacing.s1))
                    VpFactRow("Screenshot protection", "On", VpTone.SAFE)
                    VpFactRow("Clipboard copy", "Disabled", VpTone.SAFE)
                    VpFactRow("Automatic hide", "60 seconds", VpTone.SAFE)
                }
                if (loading) {
                    Box(Modifier.fillMaxWidth().padding(Spacing.s5), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else {
                    VpPrimaryButton(
                        text = "Authenticate and show phrase",
                        onClick = ::authenticateAndReveal,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            } else {
                RecoveryWordGrid(words)
                VpOutlineButton(
                    text = "Hide recovery phrase",
                    onClick = {
                        words = emptyList()
                        message = "Recovery phrase hidden."
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            message?.let { VpRiskBanner(VpTone.INFO, "Recovery phrase", it) }
        }
    }
}

internal fun canDisplayRecoveryPhrase(
    authenticationSucceeded: Boolean,
    appResumed: Boolean,
    generationMatches: Boolean,
    wordsPresent: Boolean,
): Boolean = authenticationSucceeded && appResumed && generationMatches && wordsPresent

@Composable
private fun RecoveryWordGrid(words: List<String>) {
    Surface(shape = VelarumRadii.xl, color = VelarumTheme.colors.surfaceInverse, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Spacing.s4), verticalArrangement = Arrangement.spacedBy(Spacing.s2)) {
            words.chunked(2).forEachIndexed { rowIndex, pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s2)) {
                    pair.forEachIndexed { columnIndex, word ->
                        RecoveryWordCell(
                            index = rowIndex * 2 + columnIndex + 1,
                            word = word,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun RecoveryWordCell(index: Int, word: String, modifier: Modifier = Modifier) {
    Surface(shape = VelarumRadii.sm, color = Color.White.copy(alpha = 0.08f), modifier = modifier) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.s3, vertical = Spacing.s2),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s2),
        ) {
            Text(index.toString(), style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textFaint)
            Text(word, style = MaterialTheme.typography.bodyMedium, color = Color.White)
        }
    }
}
