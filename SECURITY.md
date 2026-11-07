# Security policy

Nebula handles Git credentials (GitHub tokens via `gh`, GitLab personal access tokens, SSH keys), so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: **Security › Report a vulnerability** on this repository. Include steps to reproduce and the impact you expect.

You should get a first answer within a week.

## How Nebula treats secrets

- GitLab tokens are encrypted with the operating system's credential store through Electron `safeStorage` (macOS Keychain, Windows Data Protection API (DPAPI), Linux Secret Service/kwallet) and never written in plain text.
- GitHub tokens stay in `gh`; Nebula reads the token for the account chosen for a repository and passes it only to that command's environment (`GIT_CONFIG_*` extra header, `GH_TOKEN`). The global `gh` account is never switched.
- SSH private keys are generated locally with `ssh-keygen` and never leave your machine; only the public key is uploaded, after you confirm.
- Git and `gh` are always executed with argument arrays, never through a shell.
- The renderer runs with context isolation and talks to the main process through an allow-listed preload bridge.
