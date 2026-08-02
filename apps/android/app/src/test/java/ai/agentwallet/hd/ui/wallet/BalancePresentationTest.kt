package ai.agentwallet.hd.ui.wallet

import ai.agentwallet.hd.AssetBalance
import org.junit.Assert.assertEquals
import org.junit.Test

class BalancePresentationTest {
    @Test
    fun inactiveAccountIsNotPresentedAsConfirmedZero() {
        val balance = AssetBalance(balance = "0", status = "inactive")

        assertEquals(BalanceCondition.INACTIVE, balanceCondition(balance))
        assertEquals("—", displayBalance(balance))
        assertEquals("Account not activated", balanceStatusLabel(balance))
    }

    @Test
    fun networkFailureIsNotPresentedAsConfirmedZero() {
        val balance = AssetBalance(balance = "--", status = "error", error = "timeout")

        assertEquals(BalanceCondition.ERROR, balanceCondition(balance))
        assertEquals("—", displayBalance(balance))
        assertEquals("Refresh failed", balanceStatusLabel(balance))
    }

    @Test
    fun missingSnapshotIsNotPresentedAsConfirmedZero() {
        assertEquals(BalanceCondition.UNKNOWN, balanceCondition(null))
        assertEquals("—", displayBalance(null))
        assertEquals("Not refreshed", balanceStatusLabel(null))
    }

    @Test
    fun successfulZeroAndFundedBalancesRemainDistinct() {
        val zero = AssetBalance(balance = "0", status = "ok")
        val funded = AssetBalance(balance = "100", status = "ok")

        assertEquals(BalanceCondition.ZERO, balanceCondition(zero))
        assertEquals("0", displayBalance(zero))
        assertEquals("Zero balance", balanceStatusLabel(zero))
        assertEquals(BalanceCondition.AVAILABLE, balanceCondition(funded))
        assertEquals("100", displayBalance(funded))
        assertEquals("In wallet", balanceStatusLabel(funded))
    }
}
