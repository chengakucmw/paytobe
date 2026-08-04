package ai.agentwallet.hd.ui

import ai.agentwallet.hd.ui.navigation.Routes
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VelarumAppRefreshPolicyTest {
    @Test
    fun inboxReloadsWheneverItsRouteBecomesVisible() {
        assertTrue(shouldReloadInbox(Routes.INBOX))
        assertFalse(shouldReloadInbox(Routes.HOME))
        assertFalse(shouldReloadInbox("${Routes.DETAIL}/prq_example"))
    }
}
