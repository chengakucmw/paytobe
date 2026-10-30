#!/usr/bin/env bash
# ============================================================================
# 一键打出「可直接装真机」的 release APK（已开启 R8 优化 + Baseline Profile）。
#
# 用法（在项目根目录的终端里）：
#     bash apps/android/scripts/build-release-apk.sh
#
# 产物：apps/android/app/build/outputs/apk/release/Paytobe-release.apk
# 前提：本机已装好 Android SDK（装了 Android Studio 即自带）。
# ============================================================================
set -euo pipefail

# 进入 android 工程根目录（本脚本所在 scripts/ 的上一级）
cd "$(dirname "$0")/.."

echo "▶ 正在构建 release APK（首次会下载依赖并做 R8 优化，耗时较久，请耐心等）…"
./gradlew :app:assembleRelease

APK="$(pwd)/app/build/outputs/apk/release/Paytobe-release.apk"
echo ""
if [ -f "$APK" ]; then
  echo "✅ 完成！可直接安装的 APK 在："
  echo "   $APK"
  echo ""
  echo "把它装到手机的两种方式："
  echo "  • 手机用 USB 连电脑、开启「USB 调试」后，运行：  adb install -r \"$APK\""
  echo "  • 或把这个 .apk 文件传到手机上，用文件管理器点开安装（需允许「未知来源」）。"
else
  echo "⚠ 没找到 APK，请往上翻构建日志看是否报错（多半是 SDK 路径或依赖下载问题）。"
  exit 1
fi
