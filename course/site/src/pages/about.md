---
title: About this course
tag: About
lead: Who made it, what it promises, and what it does not collect.
---

## What it promises

Every block labelled Terminal on these pages is a real run, captured on a real Mac, and its footer
says where it came from. Most footers name the machine, the macOS version, the commit and the date; the
older captures name the checkpoint run they came from, and are being re-recorded with the full
details. Every block of reference VMM code, the
ones headed by a file path and line numbers, is pulled from the repository when the site is built,
so the text cannot drift from the code. Short shell snippets, and the small examples a primer
writes out to explain an idea, are typed by hand; they are not labelled Terminal and make no
claim to be a captured run. Where something could not be
checked, the chapter says so plainly. The macOS-guest chapters are research chapters: they state
what was and was not observed, and never claim a guest booted unless it was seen booting.

## What it collects

Nothing. There are no cookies, no analytics and no accounts. The "Mark complete" buttons and the
checkpoint boxes store your progress only in this browser (`localStorage`), and the site works the
same without it. The labs run entirely on your machine: a file you open in a lab is read locally
and never uploaded.

## Security

The VMM you build treats everything a guest hands it as hostile input, and the course teaches why
at each step; [chapter 25](/build-your-own/vmm/production/security/) brings it together as a threat
model. The site itself loads nothing from other origins and runs no inline scripts: its
Content-Security-Policy allows only its own files.

## Contact

Corrections and questions are welcome at the address in the footer.
