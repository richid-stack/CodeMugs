# Contributing

## Workflow

1. Branch from `main`. Keep changes small and focused.
2. Run `pnpm verify` before pushing. It runs the same checks as CI.
3. Open a pull request using the template. CI must pass before merge.
4. `main` is protected. See [repository setup](docs/engineering/repository-setup.md) for the expected settings.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Explain why in the body when it is not obvious.

## Standards

- Follow the [engineering standards](docs/engineering/standards.md).
- Test failure paths, not only the happy path.
- A change to an architectural decision, or to a security or data boundary, needs a [decision record](docs/architecture/decisions/).
- Keep the README's "What exists today" table and the roadmap honest. Do not describe planned work as done.

## Dependencies

- Versions are pinned exactly and `pnpm-lock.yaml` is committed. Renovate proposes updates.
- Packages that want to run install scripts are denied by default. Review before allowing one in `pnpm-workspace.yaml`.
- Justify new dependencies in the pull request.

## Security

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Never commit secrets or customer data.
