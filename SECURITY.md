# Security Policy

## Supported Versions

Only the latest published `1.x` release is supported with security fixes.
There is no long-term-support branch at this time.

| Version | Supported |
| ------- | --------- |
| 1.1.x   | Yes       |
| < 1.1   | No        |

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Instead, report privately via
[GitHub Security Advisories](https://github.com/trellislabs-hq/fooddata-central-mcp/security/advisories/new)
for this repository. Include:

- A description of the issue and its potential impact
- Steps to reproduce, if possible
- Any suggested fix or mitigation

This is a best-effort, bootstrapped open source project — there is no
guaranteed response SLA, but security reports are prioritized over other
issues.

## Scope Notes

This server proxies requests to the USDA FoodData Central API using a key
you supply via the `FDC_API_KEY` environment variable. The server itself
has no telemetry, no persistent storage, and no network destinations other
than `api.nal.usda.gov`. Vulnerabilities in the upstream USDA API are out of
scope for this repository — report those to USDA directly.
