package ai.agentwallet.hd;

import org.junit.Test;

import java.math.BigInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class AmountUnitsTest {
    @Test
    public void api26CompatibleExactLongPreservesBothBoundaries() {
        assertEquals(Long.MIN_VALUE, AmountUnits.longValueExact(BigInteger.valueOf(Long.MIN_VALUE)));
        assertEquals(Long.MAX_VALUE, AmountUnits.longValueExact(BigInteger.valueOf(Long.MAX_VALUE)));
    }

    @Test
    public void api26CompatibleExactLongRejectsOverflow() {
        assertThrows(
                ArithmeticException.class,
                () -> AmountUnits.longValueExact(BigInteger.valueOf(Long.MAX_VALUE).add(BigInteger.ONE))
        );
        assertThrows(
                ArithmeticException.class,
                () -> AmountUnits.longValueExact(BigInteger.valueOf(Long.MIN_VALUE).subtract(BigInteger.ONE))
        );
    }
}
