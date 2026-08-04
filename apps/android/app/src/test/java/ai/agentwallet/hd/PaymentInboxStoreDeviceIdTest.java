package ai.agentwallet.hd;

import org.junit.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class PaymentInboxStoreDeviceIdTest {
    @Test
    public void concurrentFirstUseReturnsOneDurableIdentity() throws Exception {
        MemoryDeviceIdStore store = new MemoryDeviceIdStore(true);
        int callers = 32;
        ExecutorService executor = Executors.newFixedThreadPool(callers);
        CountDownLatch ready = new CountDownLatch(callers);
        CountDownLatch start = new CountDownLatch(1);
        List<AtomicReference<String>> results = new ArrayList<>();

        for (int i = 0; i < callers; i++) {
            AtomicReference<String> result = new AtomicReference<>();
            results.add(result);
            executor.execute(() -> {
                ready.countDown();
                try {
                    start.await();
                    result.set(PaymentInboxStore.getOrCreateDeviceId(store));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            });
        }

        assertTrue(ready.await(5, TimeUnit.SECONDS));
        start.countDown();
        executor.shutdown();
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));

        Set<String> distinct = new HashSet<>();
        for (AtomicReference<String> result : results) {
            assertNotNull(result.get());
            distinct.add(result.get());
        }
        assertEquals(1, distinct.size());
        assertEquals(store.read(), distinct.iterator().next());
        assertEquals(1, store.persistCount.get());
    }

    @Test
    public void persistenceFailureWithoutWinningValueFailsClosed() {
        MemoryDeviceIdStore store = new MemoryDeviceIdStore(false);

        assertThrows(
                IllegalStateException.class,
                () -> PaymentInboxStore.getOrCreateDeviceId(store)
        );
        assertEquals("", store.read());
    }

    private static final class MemoryDeviceIdStore implements PaymentInboxStore.DeviceIdStore {
        private final boolean writesSucceed;
        private final AtomicInteger persistCount = new AtomicInteger();
        private volatile String value = "";

        private MemoryDeviceIdStore(boolean writesSucceed) {
            this.writesSucceed = writesSucceed;
        }

        @Override
        public String read() {
            return value;
        }

        @Override
        public boolean persist(String next) {
            persistCount.incrementAndGet();
            if (!writesSucceed) return false;
            value = next;
            return true;
        }
    }
}
