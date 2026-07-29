# Security Policy

## Supported versions

Security fixes are applied to the latest published release on the `main` branch.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for this repository:

https://github.com/xaya1001/copy-content-with-tree/security/advisories/new

If advisories are unavailable, email the maintainer through the contact listed on the GitHub profile associated with publisher `xaya1001`.

Do **not** open a public issue for vulnerabilities that could expose local file contents, symlink escape, or command injection.

## Scope notes

This extension reads local files selected by the user and may run `git` in trusted workspaces. Reports related to:

- unintended absolute-path leakage in clipboard output
- symlink escape beyond workspace/selection boundaries
- Git argument injection
- unsafe defaults in configuration schema

are in scope.
