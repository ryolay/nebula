# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Windows and Linux support: native window controls, Ctrl-based shortcuts and labels, PowerShell/cmd terminal on Windows, Windows-style paths in identities and SSH config.
- Installers for every platform (DMG and zip for macOS arm64/x64, NSIS installer and zip for Windows, AppImage, deb and tar.gz for Linux), built and published by CI when a version tag is pushed.
- CI on macOS, Windows and Linux.

### Changed
- Packaging moved from electron-packager to electron-builder.

## [0.1.0] - 2026-11-07

First public release.

### Added
- Commit graph with lanes, avatars, branch/remote/tag labels and search.
- Staging by file, hunk or line; commit, amend, stash, cherry-pick, revert, reset.
- Merge conflict resolution (mine / theirs / both per block), continue / skip / abort.
- Undo and redo for most Git operations.
- Interactive rebase, drag-and-drop branches, file history, blame, compare.
- Remotes, worktrees, submodules and Git LFS.
- GitHub and GitLab: pull/merge requests (create with reviewers, assignees, labels, milestone), issues.
- Multiple accounts per provider, per-repository commit identities, one-click SSH.
- Repository tabs, launchpad (recent / clone / open), integrated terminal.
- Light and dark themes, accent colors, resizable panels.

[Unreleased]: https://github.com/ryolay/nebula/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ryolay/nebula/releases/tag/v0.1.0
