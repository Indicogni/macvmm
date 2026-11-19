// Runner.swift: start a configured VZVirtualMachine, report its state, and stop it.
//
// Why this shape: a VZVirtualMachine created with `init(configuration:)` is bound to the main
// queue: "Every call must be done on the main queue and the callbacks are invoked on the main
// queue" (`VZVirtualMachine.h`). So the whole tool is single-threaded on the main queue
// (`@MainActor`) except the console reader thread. Compare macvmm, which owns one host thread
// per vCPU and handles every exit itself (architecture §14.1): here the run loop, the vCPUs
// and every device live inside Apple's XPC service, and all we get back is a state machine
// (`VZVirtualMachine.State`) and two delegate callbacks (`VZVirtualMachineDelegate.h`).
//
// Stop paths and their exit codes (Args.swift, mirroring architecture §13.2):
//   - the guest powers itself off            → `VZ guest state: stopped (guest)`, exit 0;
//   - `--seconds N`, then a polite request   → `VZ guest state: stopped (requested)`, exit 0;
//     (`requestStop`, a virtual power button the guest may ignore);
//   - the request is ignored for the grace period, or a Linux `--seconds` timeout
//                                            → `stop()` (pulls the plug), exit 5;
//   - `virtualMachine(_:didStopWithError:)`  → exit 3;
//   - SIGINT/SIGTERM                         → `stop()`, exit 130.
import Darwin
import Foundation
@preconcurrency import Virtualization

/// What to do when `--seconds` expires.
enum TimeoutPolicy {
    /// Linux: the test guest powers off by itself, so a timeout means it hung: force-stop, exit 5.
    case forceStop
    /// macOS: press the virtual power button, wait `grace` seconds, then force-stop.
    case requestStop(grace: Double)
}

@MainActor
final class VMRunner: NSObject, VZVirtualMachineDelegate {
    private let vm: VZVirtualMachine
    private let console: ConsolePump?
    private var stopRequested = false
    private var finished = false
    private var consoleSettled = false
    private var signalSources: [DispatchSourceSignal] = []

    init(configuration: VZVirtualMachineConfiguration, console: ConsolePump?) {
        self.vm = VZVirtualMachine(configuration: configuration)
        self.console = console
        super.init()
        vm.delegate = self
    }

    /// Start the VM; the process exits from one of the stop paths above.
    func run(seconds: Int?, onTimeout policy: TimeoutPolicy) {
        installSignalHandlers()
        console?.start()
        stateLine("starting")
        vm.start { [self] result in
            switch result {
            case .success:
                stateLine("running")
                if let seconds { scheduleTimeout(seconds: seconds, policy: policy) }
            case .failure(let error):
                finalStateLine("error")
                finish(.error, "start failed: \(describe(error))")
            }
        }
    }

    // MARK: VZVirtualMachineDelegate (invoked on the VM's queue, which is the main queue)

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        MainActor.assumeIsolated {
            if stopRequested {
                finalStateLine("stopped (requested)")
                finish(.ok, "guest stopped after the stop request")
            } else {
                finalStateLine("stopped (guest)")
                finish(.ok, "guest powered off")
            }
        }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) {
        let text = describe(error)
        MainActor.assumeIsolated {
            finalStateLine("stopped (error)")
            finish(.guestFatal, "VM stopped with an error: \(text)")
        }
    }

    // MARK: Stop paths

    private func scheduleTimeout(seconds: Int, policy: TimeoutPolicy) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds)) {
            MainActor.assumeIsolated { self.timedOut(seconds: seconds, policy: policy) }
        }
    }

    private func timedOut(seconds: Int, policy: TimeoutPolicy) {
        guard !finished else { return }
        switch policy {
        case .forceStop:
            forceStop(status: .timeout, reason: "--seconds \(seconds) expired; guest force-stopped")
        case .requestStop(let grace):
            stopRequested = true
            do {
                try vm.requestStop()
                note("--seconds \(seconds) expired: requested a guest stop (virtual power button)")
            } catch {
                note("requestStop failed: \(describe(error))")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + grace) {
                MainActor.assumeIsolated {
                    self.forceStop(
                        status: .timeout,
                        reason: "guest ignored the stop request for \(Int(grace)) s; force-stopped")
                }
            }
        }
    }

    /// `stop()` discards guest state like pulling the power cord (`VZVirtualMachine.h`).
    private func forceStop(status: ExitStatus, reason: String) {
        guard !finished else { return }
        guard vm.canStop else {
            finalStateLine("stopped (forced)")
            finish(status, reason)
            return
        }
        vm.stop { [self] error in
            if let error { note("stop: \(describe(error))") }
            finalStateLine("stopped (forced)")
            finish(status, reason)
        }
        // If VZ never answers, still leave (the XPC service tears the VM down with us).
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            MainActor.assumeIsolated { self.finish(status, reason + " (stop did not complete)") }
        }
    }

    private func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                MainActor.assumeIsolated {
                    self.forceStop(status: .interrupted, reason: "interrupted (signal \(sig))")
                }
            }
            src.resume()
            signalSources.append(src)
        }
    }

    /// TTY-7: once the VM has stopped, drain the console and, if the guest left the cursor
    /// mid-line (a drawn fake prompt such as `root@host:~# `), print a newline, so none of our
    /// closing lines (`VZ guest state: stopped …`, `vz-mac: …`) shares a line with guest text.
    /// Idempotent: the newline is printed at most once.
    private func settleConsole() {
        guard !consoleSettled else { return }
        consoleSettled = true
        if let console, !console.drain() {
            _ = [UInt8(0x0A)].withUnsafeBytes { writeAll(STDERR_FILENO, $0) }
        }
    }

    /// A `VZ guest state:` line for a terminal state, after `settleConsole`.
    private func finalStateLine(_ state: String) {
        settleConsole()
        stateLine(state)
    }

    /// Settle the console, print the final `vz-mac:` line on stderr (TTY-7), exit.
    private func finish(_ status: ExitStatus, _ reason: String) {
        guard !finished else { return }
        finished = true
        settleConsole()
        note("\(reason) (exit \(status.rawValue))")
        exit(status.rawValue)
    }
}

/// An error as one line, with the VZ error code when there is one (VZError.h).
func describe(_ error: any Error) -> String {
    let ns = error as NSError
    var text = ns.localizedDescription
    if let reason = ns.localizedFailureReason, !text.contains(reason) {
        text += " (\(reason))"
    }
    if ns.domain == VZErrorDomain {
        text += " [VZErrorDomain \(ns.code)]"
        if ns.code == VZError.Code.virtualMachineLimitExceeded.rawValue {
            text += "; VZ allows at most two macOS VMs at once (macOS SLA §2B(iii))"
        }
    }
    return debugQuoted(text)
}
