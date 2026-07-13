# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.5.x   | Yes       |
| < 1.5   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email **post+security@gatewarden.eu** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive an acknowledgement within 48 hours
4. We will work with you to understand and address the issue before any public disclosure

## Scope

The following are in scope:

- Authentication and token handling (`nxs_pat_*` tokens, `NEXUS_PRIVATE_TOKEN`)
- Network communication (Nexus API requests, Helicone API requests)
- Local file system operations (plugin cache at `.nexus/headroom-cache/`, log files)
- Plugin hook execution and MCP tool output handling

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time
to address the issue before making it public.
