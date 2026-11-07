# infrastructure/docker

- `compose.dev.yml`: local development dependencies (Postgres with pgvector, Redis). Credentials are for local use only and ports bind to loopback. Start with `pnpm infra:up`.
- `Dockerfile.api`: multi-stage production image for `@codemugs/api`. Runs as a non-root user and includes a health check. Build from the repository root:

```bash
docker build -f infrastructure/docker/Dockerfile.api -t codemugs-api .
docker run --init --rm -p 3000:3000 codemugs-api
```

**Verification status:** the compose file has been validated with `docker compose config`, and the image's `pnpm deploy` step has been reproduced and booted outside Docker. The image itself has not been built yet; CI builds it on every push.
