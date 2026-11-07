# Security policy

Agent Mandate moves money on behalf of a human, so the threat model is part of
the product. The full model — assets, 20 adversaries, the control that stops
each one, the test that proves it, and the deliberate demo limits — is in
[docs/SECURITY.md](docs/SECURITY.md).

## Reporting a vulnerability

Open a private security advisory on
[the repository](https://github.com/filippooplesca3-wq/MandateAgent/security/advisories)
rather than a public issue. Please include the affected route or module, a
reproduction, and the impact you believe it has.

## Scope

In scope: the mandate signature and policy engine, the guarded PayPal tools,
approval binding, budget accounting, the HTTP API, and the hosted replay's
read-only guarantees.

Out of scope for this demo: the seeded seller trust fixtures, the in-memory
store's loss of state on restart, and the absence of multi-tenant authentication
on read endpoints. These are documented as demo boundaries in
[docs/SECURITY.md](docs/SECURITY.md).
