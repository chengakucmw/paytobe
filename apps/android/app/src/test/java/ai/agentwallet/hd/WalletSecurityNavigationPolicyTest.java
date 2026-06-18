package ai.agentwallet.hd;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WalletSecurityNavigationPolicyTest {
    @Test
    public void mnemonicEntryIsOnlyAllowedUnderSettingsSecurity() {
        assertFalse(WalletSecurityNavigationPolicy.allowsMnemonicEntry(WalletSecurityNavigationPolicy.SURFACE_HOME));
        assertFalse(WalletSecurityNavigationPolicy.allowsMnemonicEntry(WalletSecurityNavigationPolicy.SURFACE_PROFILE));
        assertTrue(WalletSecurityNavigationPolicy.allowsMnemonicEntry(WalletSecurityNavigationPolicy.SURFACE_SETTINGS_SECURITY));
        assertTrue(WalletSecurityNavigationPolicy.allowsMnemonicEntry("settings/security/recovery_phrase_backup"));
    }

    @Test
    public void signingRequiresLoadedWalletVerifiedBackupAndReadyPayment() {
        assertFalse(WalletSecurityNavigationPolicy.canCreateSignature(false, true, true));
        assertFalse(WalletSecurityNavigationPolicy.canCreateSignature(true, false, true));
        assertFalse(WalletSecurityNavigationPolicy.canCreateSignature(true, true, false));
        assertTrue(WalletSecurityNavigationPolicy.canCreateSignature(true, true, true));
    }

    @Test
    public void backupGateOnlyAppearsForReadyPaymentsWithUnverifiedLoadedWallet() {
        assertFalse(WalletSecurityNavigationPolicy.requiresBackupGate(false, false, true));
        assertFalse(WalletSecurityNavigationPolicy.requiresBackupGate(true, true, true));
        assertFalse(WalletSecurityNavigationPolicy.requiresBackupGate(true, false, false));
        assertTrue(WalletSecurityNavigationPolicy.requiresBackupGate(true, false, true));
    }
}
