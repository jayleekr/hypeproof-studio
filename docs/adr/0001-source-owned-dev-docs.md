# 0001 — Source-owned dev docs

Status: Accepted

## Context

The member portal needs polished documentation, but the factual source for
Studio behavior lives beside the Studio code. If the portal becomes the source
of truth, requirements, tests, and release notes drift away from implementation.

## Decision

Studio keeps canonical dev docs in `docs/dev/*`, ADRs in `docs/adr/*`, and
product version metadata in `hypeproof.docs.yaml`. `hypeprooflab` imports and
renders selected docs for members. The shared docs harness is vendored from
`hypeproof-harness` and must pass before member docs are treated as releasable.

## Consequences

Feature PRs must update source docs when behavior changes. The portal can focus
on authentication, IA, rendering, screenshots, and deployment quality. The cost
is more documentation discipline inside the product repo, but the benefit is
lower drift and stronger release review.
