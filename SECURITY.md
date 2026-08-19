# Security policy

## What ClassG is, threat-wise

ClassG is a **passive, receive-only** drone detection system. It transmits
nothing, ever — no code path jams, spoofs, deauthenticates, or takes over
anything, and keeping it that way is a hard design constraint
([docs/research/06-legal-and-ethics.md](docs/research/06-legal-and-ethics.md)).
Its security surface is therefore mostly inward:

- **It parses RF it does not control.** A malformed beacon that crashes or
  hangs a parser turns the detector off — a denial of service against a
  sensor someone may be relying on. The property tests assert arbitrary
  bytes never crash the parsers; anything that gets past them is a
  vulnerability, not a nuisance.
- **The web API carries accounts, sessions, and operator location.**
  Authentication bypasses, privilege escalation between the
  viewer/operator/admin roles, or leaks of the data
  [ADR-0006](docs/architecture/adr/0006-storage-turso-libsql.md) discusses
  are all in scope.
- **The detection bus is unauthenticated by design** and bound to loopback
  by default. Configurations or bugs that let an untrusted network publish
  fabricated detections into fusion are in scope.
- **Host agents hold narrow sudo grants.** Anything that widens what the
  watchdog, sweep, or deploy agents can do with those grants is in scope.

## Reporting

Please report vulnerabilities privately through **GitHub's private
vulnerability reporting** on this repository (Security tab → "Report a
vulnerability"), rather than in a public issue. Reports that describe how to
make the detector stop detecting, see data it should not show, or act with
privileges it should not have are all welcome — a proof of concept against
the synthetic-capture demo path (no hardware needed) is ideal.

Non-sensitive hardening suggestions are fine as ordinary issues.

This is a small open-source project: expect an acknowledgement within a
week, a fix on a best-effort timeline, and credit if you want it. There is
no bounty program.

## Supported versions

`main` only. There are no maintained release branches; fixes land on `main`
and deployed units pick them up through the CI-gated pull deploy
([docs/ops/10-continuous-deployment.md](docs/ops/10-continuous-deployment.md)).
