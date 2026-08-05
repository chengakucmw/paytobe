package ai.agentwallet.hd.ui.wallet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryPhraseRevealPolicyTest {
    @Test
    fun revealRequiresAuthenticationForegroundCurrentSessionAndWords() {
        assertTrue(canDisplayRecoveryPhrase(true, true, true, true))
        assertFalse(canDisplayRecoveryPhrase(false, true, true, true))
        assertFalse(canDisplayRecoveryPhrase(true, false, true, true))
        assertFalse(canDisplayRecoveryPhrase(true, true, false, true))
        assertFalse(canDisplayRecoveryPhrase(true, true, true, false))
    }
}
