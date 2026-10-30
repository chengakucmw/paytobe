# ============================================================================
# Paytobe — R8 / ProGuard 规则（release 正式版专用）
# ----------------------------------------------------------------------------
# 设计原则：宁可少删一点，也绝不能因为 R8 误删/改名而让钱包在 release 崩溃。
# 因此对「靠反射 / JNI 原生 / 序列化」工作的库（JNA、web3j、bitcoinj、
# BouncyCastle 等）一律 keep 住。Compose / AndroidX 自带消费者规则，无需在此重复。
# 想进一步缩小体积，可在真机验证 release 完全正常后，再逐步收紧下面的规则。
# ============================================================================

# --- 保留调试用元数据：崩溃栈可被 mapping.txt 还原（行号/源文件）-----------------
-keepattributes Signature, *Annotation*, EnclosingMethod, InnerClasses, Exceptions
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile

# --- 通用安全网：原生方法、枚举、Parcelable、Serializable ------------------------
-keepclasseswithmembernames class * { native <methods>; }
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# ============================================================================
# JNA —— 稳定 C ABI 钱包核心靠它做 JNI 调用，反射极重，必须完整保留
# ============================================================================
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { *; }
-keep class * implements com.sun.jna.Library { *; }
-keep interface * extends com.sun.jna.Library { *; }
-keepclassmembers class * extends com.sun.jna.Structure { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# ============================================================================
# web3j（EVM 签名/RPC）—— 含 Jackson 反序列化，需保留
# ============================================================================
-keep class org.web3j.** { *; }
-dontwarn org.web3j.**
-keep class com.fasterxml.jackson.** { *; }
-keepclassmembers class * {
    @com.fasterxml.jackson.annotation.* <fields>;
    @com.fasterxml.jackson.annotation.* <methods>;
}
-dontwarn com.fasterxml.jackson.**

# ============================================================================
# bitcoinj（HD 助记词/派生相关）—— 含 protobuf、guava、slf4j
# ============================================================================
-keep class org.bitcoinj.** { *; }
-dontwarn org.bitcoinj.**
-keep class com.google.protobuf.** { *; }
-dontwarn com.google.protobuf.**
-dontwarn com.google.common.**
-dontwarn com.google.errorprone.**
-dontwarn org.slf4j.**
-dontwarn javax.annotation.**

# ============================================================================
# BouncyCastle（web3j/bitcoinj 的底层加解密）—— 按名加载的密码学提供方，禁止删/改名
# ============================================================================
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# ============================================================================
# OkHttp / Okio（网络）—— 自带规则，这里只压掉可选传输的告警
# ============================================================================
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn org.bouncycastle.jsse.**

# ============================================================================
# 应用自身：钱包桥 / 仓储 / 协议模型 —— 对钱包从严，保留以杜绝 R8 误伤签名链路
# （UI 层 Compose 代码可被安全优化，不在此 keep）
# ============================================================================
-keep class ai.agentwallet.hd.WalletCoreBridge { *; }
-keep class ai.agentwallet.hd.WalletRepository { *; }
-keep class ai.agentwallet.hd.HDWallet { *; }
-keep class ai.agentwallet.hd.SecureWalletStore { *; }
-keep class ai.agentwallet.hd.PaymentIntent { *; }
-keep class ai.agentwallet.hd.PaymentExecutor { *; }
-keep class ai.agentwallet.hd.RiskPolicy { *; }

# ZXing（二维码）/ MLKit（扫码）—— 多为自带规则，补一条告警抑制即可
-dontwarn com.google.zxing.**

# ============================================================================
# R8 缺失类抑制（首次 release 构建时由 build/.../missing_rules.txt 自动报出）
# 这些是第三方库里「可选、在 Android 上根本不会用到」的类，缺席不影响运行：
#   - groovy.lang.*        : 某传递依赖的 Groovy 脚本执行器（本 App 不用脚本）
#   - reactor.blockhound.* : Netty 的 BlockHound 阻塞检测调试集成（仅 JVM 调试用）
# 加 -dontwarn 让 R8 跳过即可（这正是构建日志让你补的两条规则，已用通配覆盖）。
# ============================================================================
-dontwarn groovy.lang.**
-dontwarn reactor.blockhound.**
