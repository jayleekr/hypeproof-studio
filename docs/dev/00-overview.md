---
title: Studio Developer Overview
product: studio
doc_type: overview
status: canonical
owner: core
version: 0.1.4
last_reviewed: 2026-05-22
audience: maintainers
source_paths:
  - extensions/hypeproof-chat/src
  - worker/src
  - e2e/tests
quality_gates:
  - source-paths-exist
  - version-matches-package
  - member-docs-export
---

# Studio Developer Overview

## Purpose

HypeProof Studio is the IDE-side workshop product for teaching members how to
work with AI models through concrete creation loops. The repo packages a
branded VSCodium application, a built-in chat extension, a Cloudflare Worker
proxy, and Playwright Electron tests that exercise the real application. The
product promise is not "another chat box." The promise is that a workshop
participant can install the app, receive a cohort-scoped token, talk to a coach,
generate a small game or artifact, preview it inside the IDE, and leave with a
saved project plus a traceable learning experience.

The product philosophy lives in `docs/essence-v0.1.md`. The stable behavior
contract lives in `docs/studio-requirements.md`. This dev docs set explains how
those documents map onto code, tests, release, and operations.

## Repository Scope

This repo owns the Studio desktop bundle, the `hypeproof-chat` extension, the
participant-facing Worker APIs used by the extension, workshop rehearsal tests,
and release packaging scripts. It does not own the member docs portal, long-term
knowledge memory, or Sediment retrieval architecture. Those surfaces are hosted
or implemented by sibling repos. This boundary matters because Studio release
risk is mostly client behavior, auth/token lifecycle, preview safety, and
workshop install reliability.

## Maintainer Reading Order

Start with `00-overview.md`, then read `01-architecture.md` for boundaries,
`04-requirements.md` for stable behavior, and `05-testing-requirements.md` for
the release gate. Use `08-ux-evidence.md` when reviewing whether the workshop
experience still shows the intended product. A PR that changes user-visible
behavior must update the requirement row and the test layer in the same change.
