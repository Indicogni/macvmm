# Security policy

macvmm runs guest code and parses data a guest controls, so a bug here can matter. It is also a
teaching codebase with no security audit behind it. Do not rely on it to contain a guest you
do not trust. The threat model in [`docs/security/threat-model.md`](docs/security/threat-model.md)
says what the code defends against and what it does not.

## Reporting a vulnerability

Email **feedback@indicogni.com** with "macvmm security" in the subject. Please do not open a
public issue for something exploitable until it has been fixed.

Include what you can of: the commit, the command line, the guest or input that triggers it, and
what you observed. A reproducer is worth more than a long description.

This project is maintained on a best-effort basis. Expect an acknowledgement within a week.
There is no bug bounty.

## What counts

In scope:

- a guest causing memory unsafety, a crash that is not a clean stop, or code execution in the
  `macvmm` process;
- a guest reading or writing host files, or reaching host resources, beyond what the command
  line gave it;
- a way out of the sandbox `macvmm run` applies to itself;
- the fetch and build scripts running or trusting something they did not verify;
- the course site (`indicogni.com/build-your-own/vmm/`) executing script or loading content it
  should not.

Out of scope:

- the experimental `vmapple` board and the macOS-guest research code, which are not hardened;
- runs with `--no-sandbox`, which is a debugging switch;
- denial of service by a guest against its own VM (a guest may always hang itself);
- the throwaway code under `spikes/`.

## Supported versions

Only the tip of `main`.
