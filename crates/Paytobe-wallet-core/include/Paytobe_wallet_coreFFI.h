#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct PaytobeWalletCoreResult PaytobeWalletCoreResult;

uint32_t Paytobe_wallet_core_abi_version(void);

PaytobeWalletCoreResult *Paytobe_wallet_core_call(
    const uint8_t *method,
    size_t method_len,
    const uint8_t *request,
    size_t request_len
);

const uint8_t *Paytobe_wallet_core_result_data(const PaytobeWalletCoreResult *result);
size_t Paytobe_wallet_core_result_len(const PaytobeWalletCoreResult *result);
void Paytobe_wallet_core_result_free(PaytobeWalletCoreResult *result);

#ifdef __cplusplus
}
#endif
