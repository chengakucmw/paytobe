package ai.agentwallet.hd.ui.onboarding

import kotlin.random.Random

/**
 * 助记词验证（OKX 风格「按顺序点选若干单词」）的纯逻辑。
 *
 * 设计目标：
 *  - 纯函数、无 Android 依赖 → 可单元测试（见 SeedVerificationTest）。
 *  - 与 iOS 的 SeedVerification 一一对应；二者共用同一套参考算法，已用 11 万+ 断言的随机扫描验证。
 *  - 不触碰任何签名 / 密钥 / 业务逻辑——只是「你真的抄下助记词了吗」的 UI 自检。
 */

/** 候选池里的一枚 chip。[id] 在一次挑战内稳定，用作 Compose 列表 key 与「已用」判定。 */
data class SeedOption(val id: Int, val word: String)

/**
 * 一次生成的验证挑战：
 *  - [positions]：需要填空的助记词下标（0 基，升序——所以用户「按顺序」点）。
 *  - [options]：打乱后的候选单词池（含每个空位的正确词 + 若干干扰词）。
 */
data class SeedChallenge(
    val positions: List<Int>,
    val options: List<SeedOption>,
)

object SeedVerification {
    /** 默认填 4 个空。 */
    const val DEFAULT_BLANKS = 4

    /** 候选池默认 10 枚（4 个正确 + 6 个干扰）。 */
    const val DEFAULT_OPTION_COUNT = 10

    /**
     * 由助记词生成一次挑战。给定 [random] 后是确定性的（便于测试）。
     *
     * 关键不变量（已被参考实现的属性测试覆盖）：
     *  1. positions：[blanks] 个互不相同、升序、落在 [0, words.size) 的下标。
     *  2. 每个空位的正确词都一定出现在 options 里 → 一定存在「全靠点选」就能完成的解。
     *  3. 即便助记词里有重复单词（BIP-39 允许），也为每个空位各放一枚正确 chip，足量可填。
     *  4. 干扰词取自其它位置、按字符串去重，且绝不等于任何正确词（避免歧义 chip）。
     */
    fun create(
        words: List<String>,
        blanks: Int = DEFAULT_BLANKS,
        optionCount: Int = DEFAULT_OPTION_COUNT,
        random: Random = Random.Default,
    ): SeedChallenge {
        val n = words.size
        if (n == 0) return SeedChallenge(emptyList(), emptyList())
        val k = blanks.coerceIn(1, n)

        // 1. 互不相同的位置，按升序展示（「按顺序」）。
        val positions = (0 until n).shuffled(random).take(k).sorted()

        // 2. 每个空位各放一枚正确 chip（覆盖助记词内重复词的情况）。
        val correct = positions.map { words[it] }
        val correctSet = correct.toHashSet()

        // 3. 干扰词：取自其它位置、去重、且不与任何正确词同字符串。
        val used = positions.toHashSet()
        val seen = HashSet<String>()
        val decoyPool = ArrayList<String>()
        for (i in 0 until n) {
            if (i in used) continue
            val w = words[i]
            if (w in correctSet || w in seen) continue
            seen.add(w)
            decoyPool.add(w)
        }
        decoyPool.shuffle(random)
        val decoyCount = (optionCount - k).coerceIn(0, decoyPool.size)
        val decoys = decoyPool.take(decoyCount)

        // 4. 正确 chip + 干扰 chip，整体打乱；id == 展示下标。
        val pool = (correct + decoys).toMutableList()
        pool.shuffle(random)
        val options = pool.mapIndexed { idx, w -> SeedOption(idx, w) }
        return SeedChallenge(positions, options)
    }

    /** 当且仅当 [selectedWords] 按顺序等于助记词在 [positions] 处的词时返回 true。 */
    fun isCorrect(words: List<String>, positions: List<Int>, selectedWords: List<String>): Boolean {
        if (selectedWords.size != positions.size) return false
        for (i in positions.indices) {
            val p = positions[i]
            if (p < 0 || p >= words.size) return false
            if (selectedWords[i] != words[p]) return false
        }
        return true
    }
}
