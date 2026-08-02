#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct VelarumWalletCoreResult VelarumWalletCoreResult;

uint32_t velarum_wallet_core_abi_version(void);

VelarumWalletCoreResult *velarum_wallet_core_call(
    const uint8_t *method,
    size_t method_len,
    const uint8_t *request,
    size_t request_len
);

const uint8_t *velarum_wallet_core_result_data(const VelarumWalletCoreResult *result);
size_t velarum_wallet_core_result_len(const VelarumWalletCoreResult *result);
void velarum_wallet_core_result_free(VelarumWalletCoreResult *result);

#ifdef __cplusplus
}
#endif
