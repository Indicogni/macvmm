/* hv-denied-probe: show that Hypervisor.framework refuses the private "Apple ISA" CPU mode a
 * modern macOS guest needs (PLAN M21; ADR-0008 decision 4 and ADR-0009;
 * docs/macos-guest-requirements.md §5.1). Stand-alone on purpose: macvmm never calls an
 * unheadered HVF symbol. HV_DENIED is the expected, correct answer for any normally configured
 * Mac; nothing here suggests changing SIP or AMFI, and nobody should. */
#include <Hypervisor/Hypervisor.h>
#include <dlfcn.h>
#include <stdio.h>

typedef hv_return_t (*set_isa_fn)(hv_vm_config_t config, uint32_t isa); /* signature: a guess */

int main(void) {
  /* Mach-O symbol `__hv_vm_config_set_isa`; dlsym takes the C name (one underscore fewer). */
  set_isa_fn set_isa = (set_isa_fn)dlsym(RTLD_DEFAULT, "_hv_vm_config_set_isa");
  if (set_isa == NULL) { puts("hv_vm_config_set_isa: symbol not present on this macOS"); return 2; }
  hv_vm_config_t cfg = hv_vm_config_create();
  hv_return_t set = set_isa(cfg, 3); /* 3: the value QEMU's out-of-tree vmapple RFC uses */
  hv_return_t ret = hv_vm_create(cfg);
  printf("hv_vm_config_set_isa(3): 0x%08x\n", (unsigned)set);
  printf("hv_vm_create with private ISA 3: %s (0x%08x)\n",
         ret == HV_DENIED ? "HV_DENIED" : ret == HV_SUCCESS ? "HV_SUCCESS" : "other", (unsigned)ret);
  if (ret == HV_SUCCESS) hv_vm_destroy();
  return ret == HV_DENIED ? 0 : 1;
}
