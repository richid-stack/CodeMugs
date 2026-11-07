# 0002. Hybrid deployment

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Customers will connect source repositories and, over time, production infrastructure. Many early customers are happy with a hosted platform. Larger organisations may require the platform to run inside their own infrastructure.

The options were cloud-first, hybrid (hosted first with a future self-hosted option), or self-hosted-first.

## Decision

Hybrid. The platform is hosted first, and the design keeps a self-hosted enterprise option open.

## Consequences

- Core domain code must not depend on one cloud provider's proprietary services. Storage, secrets, queues and identity sit behind interfaces.
- Configuration is environment-driven and validated at startup.
- The control plane and the data and intelligence plane stay separable.
- Self-hosted packaging, upgrade paths and support are explicitly deferred. They are not designed now, only not prevented.

## Revisit when

A concrete customer requirement for self-hosting appears, or the hosted design starts to depend on something that would make self-hosting impractical.
