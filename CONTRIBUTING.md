# Contributing

Thank you for reading the code closely enough to want to change it.

## What helps most

- **Reports from other Macs.** Everything was tested on one machine (an M5 Pro on macOS 27.2).
  If you run the quickstart on another Apple Silicon Mac or an older macOS, an issue saying what
  happened, working or not, is valuable. Include the output of `scripts/setup.sh` and
  `cargo run -p macvmm -- doctor`.
- **Corrections to the course.** A wrong statement, a command whose output differs from the
  page, a step that assumes something not yet taught. Open an issue or write to
  feedback@indicogni.com.
- **Bug reports** with the command line and what you saw.

Security problems go to the address in [SECURITY.md](SECURITY.md), not to a public issue.

## Pull requests

Small fixes are welcome. For anything larger, open an issue first: the code and the lessons are
coupled (lessons embed code by anchor, and captured output is quoted verbatim), so a change that
looks local often moves a chapter.

Before you send one:

- `scripts/check.sh` ends `CHECK OK` (format, clippy, tests, the `unsafe` audit, anchors, lesson
  lint).
- No new dependency without a line in `docs/dependencies.md`, and none for something the course
  teaches.
- `unsafe` stays in the two modules that own it, each block with a `// SAFETY:` comment.
- Captures under `course/captures/` are recordings of real runs. Re-record them
  (`scripts/capture.sh`); do not edit them by hand.
- Nothing claims a guest boots unless a recorded run shows it.

By contributing you agree that your contribution is licensed as the project is: code under
MIT OR Apache-2.0, text and diagrams under CC BY 4.0.
