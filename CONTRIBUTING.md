# Contributing to Paytobe

> **Last modified**
> - **Taipei Time:** 2026-10-29 13:41:42 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-10-29 05:41:42 UTC

Thank you for helping improve Paytobe. Keep changes focused, explain the security and compatibility impact, and add tests for behavior changes.

## Before Opening a Pull Request

1. Do not commit credentials, private keys, seed phrases, user data, production configuration, logs, or private product documents.
2. Use English for production identifiers, comments, configuration, logs, and source UI copy.
3. Preserve the non-custodial boundary: agents request, users approve, and wallets sign locally.
4. Do not add a dependency, font, icon, template, or other third-party asset until its provenance and commercial-use license are verified.
5. Direct dependencies must use the repository's approved permissive licenses. Copyleft, source-available, proprietary, unclear, and unlicensed material is not accepted.
6. Run the narrow affected tests, then run `npm run release:gate -- --node-only`. Mobile changes should also run the applicable Android or iOS gates.

## Licensing

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion in this repository are provided under Apache-2.0, consistent with the repository [LICENSE](LICENSE). Submit only work you created or material you are authorized to contribute under compatible terms, and preserve required attribution notices.

Paytobe names, logos, wordmarks, and other brand identifiers are not granted for third-party use by the Apache-2.0 code license.

## Security Reports

Do not disclose an unpatched vulnerability in an issue or pull request. Follow [SECURITY.md](SECURITY.md) instead.
