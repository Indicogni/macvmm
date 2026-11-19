// swift-tools-version: 6.0
//
// vz-mac: the Virtualization.framework companion tool (PLAN M20, ADR-0008 decision 2, course ch23).
//
// Why a separate Swift package: Virtualization.framework (VZ) is an Objective-C/Swift API, and
// the point of this tool is the *contrast* with macvmm (a policy-rich, closed VMM versus a
// mechanism we own end to end), not a lesson in Objective-C runtime FFI. It lives outside the
// Cargo workspace (the root Cargo.toml excludes `tools/`), has **no package dependencies**
// (only Apple system frameworks: Foundation, Virtualization, CryptoKit), and is signed with
// exactly one entitlement of its own, `com.apple.security.virtualization`
// (`vz-mac.entitlements`), so the `macvmm` binary keeps exactly `com.apple.security.hypervisor`
// (threat model SIGN-1).
//
// Build through `run.sh` (build, sign, exec) or `test.sh` (the on-machine acceptance).
import PackageDescription

let package = Package(
    name: "vz-mac",
    // DECISIONS D7: the project's hardware floor is Apple Silicon on macOS 15+.
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "vz-mac",
            path: "Sources/vz-mac",
            linkerSettings: [.linkedFramework("Virtualization")]
        ),
        // Host-only unit and hostile-input tests: they never create a VM, so they need no
        // entitlement (`swift test` runs them unsigned).
        .testTarget(
            name: "vz-macTests",
            dependencies: ["vz-mac"],
            path: "Tests/vz-macTests"
        ),
    ]
)
