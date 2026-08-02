package ai.agentwallet.hd.ui.wallet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.agentwallet.hd.ui.components.VpBadge
import ai.agentwallet.hd.ui.components.VpCard
import ai.agentwallet.hd.ui.components.VpOutlineButton
import ai.agentwallet.hd.ui.components.VpPrimaryButton
import ai.agentwallet.hd.ui.components.VpRiskBanner
import ai.agentwallet.hd.ui.components.VpSubheader
import ai.agentwallet.hd.ui.components.VpTone
import ai.agentwallet.hd.ui.theme.Spacing
import ai.agentwallet.hd.ui.theme.VelarumFonts
import ai.agentwallet.hd.ui.theme.VelarumTheme
import kotlinx.coroutines.delay

@Composable
fun ConnectKeyScreen(
    vm: ConnectKeyViewModel,
    onBack: () -> Unit,
    onReviewAgent: (String) -> Unit,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val clipboard = LocalClipboardManager.current
    val invitation = ui.invitation

    LaunchedEffect(Unit) { vm.reset() }
    LaunchedEffect(invitation?.id, invitation?.status) {
        while (invitation != null && !invitation.terminal && invitation.status != "approved") {
            delay(2_000)
            vm.refresh()
            delay(250)
        }
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        VpSubheader(eyebrow = "Agent connection", title = "One-time Connect Key", onBack = onBack)
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s5).padding(bottom = Spacing.s8),
            verticalArrangement = Arrangement.spacedBy(Spacing.s4),
        ) {
            VpRiskBanner(
                VpTone.INFO,
                "Public identifier, not signing authority",
                "Share this one-time key with an Agent. It can request a connection, but it cannot access wallet keys, approve payments, or sign transactions.",
            )

            if (invitation == null) {
                VpPrimaryButton(
                    text = if (ui.loading) "Creating…" else "Create Connect Key",
                    onClick = vm::create,
                    enabled = !ui.loading,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                VpCard(modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Connect Key", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                        VpBadge(invitation.status, when (invitation.status) {
                            "connected" -> VpTone.SAFE
                            "rejected", "cancelled", "expired" -> VpTone.DANGER
                            else -> VpTone.CAUTION
                        })
                    }
                    Text(
                        invitation.connectKey,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = VelarumFonts.mono),
                        color = VelarumTheme.colors.textBody,
                    )
                    Text("Expires: ${invitation.expiresAt}", style = MaterialTheme.typography.bodySmall, color = VelarumTheme.colors.textMuted)
                }
                if (invitation.status == "waiting") {
                    VpPrimaryButton(
                        text = "Copy Connect Key",
                        onClick = { clipboard.setText(AnnotatedString(invitation.connectKey)) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                if (invitation.claimed) {
                    val review = ui.review
                    if (review == null) {
                        VpRiskBanner(
                            VpTone.DANGER,
                            "Live identity unavailable",
                            "Approval is disabled. Offline or cached identity is never sufficient for a new connection.",
                        )
                    } else {
                        VpRiskBanner(
                            when (review.state) {
                                "verified" -> VpTone.SAFE
                                "pending" -> VpTone.CAUTION
                                else -> VpTone.DANGER
                            },
                            when (review.state) {
                                "verified" -> "Verified merchant and Agent"
                                "pending" -> "Verification pending"
                                "suspended" -> "Merchant, Agent, or credential suspended"
                                else -> "Identity cannot be verified"
                            },
                            "This review was fetched live from the Platform. Stable IDs and the verified domain are shown so look-alike Unicode names cannot hide identity changes.",
                        )
                        VpCard(modifier = Modifier.fillMaxWidth()) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Merchant", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                                VpBadge(review.merchantStatus.ifBlank { review.state }, if (review.state == "verified") VpTone.SAFE else VpTone.CAUTION)
                            }
                            Text(
                                review.merchantName.ifBlank { "Name unavailable" },
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.titleLarge,
                                color = VelarumTheme.colors.textStrong,
                            )
                            ReviewFact("Merchant ID", review.merchantId)
                            ReviewFact("Verified domain", review.verifiedDomain.ifBlank { "Not verified" })
                            ReviewFact("Verification", review.merchantVerificationState.ifBlank { review.reasonCode })
                        }
                        VpCard(modifier = Modifier.fillMaxWidth()) {
                            Text("Registered Agent", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                            Text(
                                review.agentName.ifBlank { "Name unavailable" },
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.titleLarge,
                                color = VelarumTheme.colors.textStrong,
                            )
                            ReviewFact("Agent ID", review.agentId)
                            ReviewFact("Runtime", review.runtime)
                            ReviewFact("Agent status", review.agentStatus)
                            ReviewFact("Credential ID", review.credentialId)
                            ReviewFact("Credential status", review.credentialStatus)
                            ReviewFact("Credential expires", review.credentialExpiresAt)
                            ReviewFact("Invitation expires", review.expiresAt)
                        }
                        VpCard(modifier = Modifier.fillMaxWidth()) {
                            Text("Requested permissions", style = MaterialTheme.typography.titleMedium, color = VelarumTheme.colors.textStrong)
                            review.requestedScopes.forEach { scope ->
                                Text("· $scope", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textBody)
                            }
                            Text(
                                "These scopes can create or read requests only. They never grant signing, recovery-phrase, private-key, approval, or automatic-payment authority.",
                                style = MaterialTheme.typography.bodySmall,
                                color = VelarumTheme.colors.textMuted,
                            )
                        }
                        VpPrimaryButton(
                            text = if (ui.deciding) "Approving…" else "Approve verified connection",
                            onClick = vm::approve,
                            enabled = review.approvableNow && !ui.deciding,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    VpOutlineButton(
                        text = if (ui.deciding) "Working…" else "Reject connection",
                        onClick = vm::reject,
                        enabled = invitation.status == "claimed" && !ui.deciding,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else if (!invitation.terminal) {
                    Text("Waiting for an Agent to claim this key…", style = MaterialTheme.typography.bodyMedium, color = VelarumTheme.colors.textMuted)
                }

                if (!invitation.terminal) {
                    VpOutlineButton(
                        text = if (ui.cancelling) "Cancelling…" else "Cancel Connect Key",
                        onClick = vm::cancel,
                        enabled = !ui.cancelling,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            ui.error?.let { VpRiskBanner(VpTone.DANGER, "Connect Key error", it) }
        }
    }
}

@Composable
private fun ReviewFact(label: String, value: String) {
    Text(
        "$label: ${value.ifBlank { "Unavailable" }}",
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = VelarumFonts.mono),
        color = VelarumTheme.colors.textBody,
    )
}
