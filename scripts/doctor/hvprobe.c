// hvprobe: the smallest possible "does Hypervisor.framework work here?" program (course ch00).
// Built and signed by scripts/doctor.sh, independent of Rust, so a broken toolchain cannot hide
// a working hypervisor (or the reverse). Declarations come from the SDK's <Hypervisor/...>.
#include <Hypervisor/Hypervisor.h>
#include <stdio.h>

int main(void) {
    hv_return_t r = hv_vm_create(NULL);
    if (r != HV_SUCCESS) {
        fprintf(stderr, "doctor: hv_vm_create: FAILED (0x%08x)\n", (unsigned)r);
        return 1;
    }
    printf("doctor: hv_vm_create: OK\n");
    uint32_t max_ipa = 0, def_ipa = 0;
    bool el2 = false;
    if (hv_vm_config_get_max_ipa_size(&max_ipa) != HV_SUCCESS ||
        hv_vm_config_get_default_ipa_size(&def_ipa) != HV_SUCCESS ||
        hv_vm_config_get_el2_supported(&el2) != HV_SUCCESS) {
        fprintf(stderr, "doctor: capability queries failed\n");
        return 1;
    }
    printf("doctor: max IPA: %u bits (default %u)\n", max_ipa, def_ipa);
    printf("doctor: EL2 supported: %s\n", el2 ? "yes" : "no");
    return hv_vm_destroy() == HV_SUCCESS ? 0 : 1;
}
