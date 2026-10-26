# Documentation

Everything written down about Opal Line Billing: what the product is, how it
is built, how to change it safely, and how to ship it.

**New here?** Read [AGENTS.md](./AGENTS.md) first — it is the operating
manual. The [root README](../README.md) is the customer-facing overview
(install, ports, Shopify setup); this directory is the engineering reference.

---

## Start here

| Document | What it answers |
|---|---|
| [AGENTS.md](./AGENTS.md) | "How do I work in this repo without breaking it?" — setup, ground rules, common tasks, the traps that bite |
| [PRD.md](./PRD.md) | "What must the product do?" — users, scope, functional and non-functional requirements, success criteria |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | "How is it built?" — topologies, request lifecycle, data layer, frontend and Electron integration |
| [DEVELOPING.md](./DEVELOPING.md) | "How do I get a green build?" — clone-to-green setup, CI, releases, dependency-major migrations |

---

## Working on the code

| Document | What it answers |
|---|---|
| [CODE_STYLE.md](./CODE_STYLE.md) | "How is code written here?" — naming, structure, comments, imports, and the rules the linters enforce |
| [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) | "How should this screen look?" — tokens, colour, type, spacing, motion, components, accessibility |
| [SECURITY.md](./SECURITY.md) | "What protects the data?" — auth, sessions, RBAC, request guards, secrets at rest, webhooks, audit trail |
| [TESTING.md](./TESTING.md) | "How do I prove it works?" — the four test layers, where a new test belongs, how to debug a failure |

---

## Configuration and operations

| Document | What it answers |
|---|---|
| [CONFIGURATION.md](./CONFIGURATION.md) | "What can be configured, and where?" — every env var, every in-app setting, every integration |
| [DEPLOYMENT.md](../DEPLOYMENT.md) | "How do I run this in production?" (repository root) |
| [ROADMAP.md](../ROADMAP.md) | "What is planned?" (repository root) |
| [shopify-flow-webhook.md](./shopify-flow-webhook.md) | "How do I auto-fill customer PII on Shopify orders?" |
| [database-password-admin.md](./database-password-admin.md) | "How do I get into the database and reset a password by hand?" |
| [recovery-password.md](./recovery-password.md) | "How do I log in when the owner forgets the password?" |

---

## Release engineering

| Document | What it answers |
|---|---|
| [code-signing.md](./code-signing.md) | "Why does Windows show 'Windows protected your PC'?" — the self-signed-certificate runbook |
| [signing-and-smartscreen.md](./signing-and-smartscreen.md) | "What does the user actually see, and what do we tell them?" |
| [buy-a-code-signing-cert.md](./buy-a-code-signing-cert.md) | "How do we buy a real certificate and install it?" |
| [release-notes-v1.0.9.md](./release-notes-v1.0.9.md) | Release history — v1.0.9 |
| [release-notes-v1.0.10.md](./release-notes-v1.0.10.md) | Release history — v1.0.10 |
| [release-notes-v1.0.11.md](./release-notes-v1.0.11.md) | Release history — v1.0.11 |

---

## Conventions in this folder

- One document, one question. If a document answers two questions, split it.
- **Describe the code as it is, not as it should be.** A doc that describes an
  aspiration is worse than no doc, because it is believed.
- Every claim must be checkable against the tree: a file path, a command, a
  line of configuration. If it cannot be verified, it does not go in.
- No secrets, no customer data, no real shop identifiers.
- Use the British spellings the codebase already uses ("behaviour",
  "colour", "authorisation") and keep the code's own identifiers verbatim
  (`requirePermission`, `db:push`, `opal.session`).
- Mermaid diagrams are fine and preferred over ASCII art, but keep them small
  enough to read in a terminal.
- Cross-link rather than repeat. If two documents need the same explanation,
  it lives in one of them and the other links to it.

---

## Maintenance

| Document | What it answers |
|---|---|
| [DEVELOPING.md](./DEVELOPING.md) | The setup, CI and release procedures — read it before changing the build |
| [CONFIGURATION.md](./CONFIGURATION.md) | Update it **in the same commit** as any new environment variable or in-app setting |

If a document contradicts the code, the code wins — fix the document in the
same commit that changed the behaviour.
