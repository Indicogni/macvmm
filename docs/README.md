# About these documents

This directory is the project's working record, published as it was written. Read it for the
reasoning behind the code, not as a manual: the manual is the [README](../README.md) and the
[course](https://indicogni.com/build-your-own/vmm/).

- **Current and maintained:** `architecture.md`, `security/` (the threat model), `adr/`,
  `dependencies.md`, `compat/`, `macos/status.md`, `DECISIONS.md`.
- **Dated records, kept for history:** `PLAN.md` (the execution plan, with milestones `M0` to
  `M23`), `research/`, `validation/` (verbatim runs, each dated), `course-backlog.md`. Statements
  there were true on the date they carry. Where a later decision changed something,
  `DECISIONS.md` is the authority.

Some vocabulary in these files comes from how the project was built:

- **"the lead"** and **"the owner"** both mean the maintainer, Indicogni LLC.
- **"engineer-agent"**, **"session"** and **"run"** refer to AI coding agents. The project was
  built with them under the maintainer's direction, and every result recorded here was observed
  on a real Mac. `CLAUDE.md` at the repository root is the brief those agents work from.
- **`M<number>`** is a plan milestone, **`D<number>`** a decision in `DECISIONS.md`, and
  identifiers such as `MEM-9` or `SC-12` are entries in the threat model.

Licence: prose and diagrams here are CC BY 4.0 ([course/LICENSE](../course/LICENSE)); code
quoted in them is MIT OR Apache-2.0. See the README.
