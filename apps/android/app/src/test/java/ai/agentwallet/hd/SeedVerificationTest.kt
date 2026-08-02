package ai.agentwallet.hd

import ai.agentwallet.hd.ui.onboarding.SeedVerification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * 助记词验证纯逻辑（OKX 风格点选）的单元测试。
 * 与 iOS SeedVerification 共用同一参考算法（参考实现已用 11 万+ 断言扫描，0 失败）。
 */
class SeedVerificationTest {

    private fun phrase(len: Int, rnd: Random, smallPool: Boolean): List<String> =
        (0 until len).map { "w" + rnd.nextInt(if (smallPool) 6 else 200) } // smallPool ⇒ 强制大量重复

    @Test
    fun propertiesHoldAcrossManySeeds() {
        val lengths = listOf(12, 15, 18, 21, 24)
        for (seed in 1..2000) {
            val rnd = Random(seed.toLong())
            val len = lengths[seed % lengths.size]
            val words = phrase(len, rnd, smallPool = seed % 3 == 0)
            val ch = SeedVerification.create(words, random = rnd)

            // 1. positions：数量 / 互异 / 升序 / 在范围内
            assertEquals(SeedVerification.DEFAULT_BLANKS, ch.positions.size)
            assertEquals(ch.positions.size, ch.positions.toSet().size)
            for (i in 1 until ch.positions.size) assertTrue(ch.positions[i - 1] < ch.positions[i])
            assertTrue(ch.positions.all { it in 0 until len })

            // 2. 每个空位的正确词都在候选里（一定可解）
            for (p in ch.positions) assertTrue(ch.options.any { it.word == words[p] })

            // 3. 重复词足量：某词被 m 个空位需要 ⇒ 池里该词 ≥ m 枚
            val need = ch.positions.groupingBy { words[it] }.eachCount()
            val have = ch.options.groupingBy { it.word }.eachCount()
            for ((w, m) in need) assertTrue((have[w] ?: 0) >= m)

            // 4. chip id 唯一
            assertEquals(ch.options.size, ch.options.map { it.id }.toSet().size)

            // 5. 正确选择 → 通过
            val good = ch.positions.map { words[it] }
            assertTrue(SeedVerification.isCorrect(words, ch.positions, good))

            // 6. 错误选择 → 失败
            val bad = good.toMutableList()
            bad[0] = "__nope__"
            assertFalse(SeedVerification.isCorrect(words, ch.positions, bad))

            // 7. 长度不符 → 失败
            assertFalse(SeedVerification.isCorrect(words, ch.positions, good.dropLast(1)))
        }
    }

    @Test
    fun handlesDuplicateWordsInPhrase() {
        val words = listOf("aa", "bb", "aa", "cc", "dd", "aa", "ee", "ff", "gg", "hh", "ii", "jj")
        for (s in 1..300) {
            val ch = SeedVerification.create(words, random = Random((s * 7 + 1).toLong()))
            val need = ch.positions.count { words[it] == "aa" }
            val have = ch.options.count { it.word == "aa" }
            assertTrue("need=$need have=$have", have >= need)
            assertTrue(SeedVerification.isCorrect(words, ch.positions, ch.positions.map { words[it] }))
        }
    }

    @Test
    fun emptyPhraseYieldsEmptyChallenge() {
        val ch = SeedVerification.create(emptyList())
        assertTrue(ch.positions.isEmpty())
        assertTrue(ch.options.isEmpty())
    }
}
