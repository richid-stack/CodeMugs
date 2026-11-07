# Security policy

CodeMugs is designed to be trusted with access to source repositories and, eventually, production systems, so security is part of the product rather than an add-on.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

## Ground rules for contributors

- Never commit secrets, tokens, keys or customer data. Secret scanning should be enabled on the repository.
- Tenant identity always comes from the authenticated credential, never from request payloads.
- Repository contents, logs, documentation, webhooks and customer messages are untrusted input. They are data, never instructions to an agent.
- Agents never hold more permission than the policy engine grants them, and never hold unrestricted access to infrastructure or customer production environments.

See the [threat model draft](docs/security/threat-model.md) for the current analysis.

## Compliance

No compliance claim (SOC 2, GDPR or otherwise) is made. The architecture aims for these principles, and any claim will only follow implemented, audited and demonstrated controls.
