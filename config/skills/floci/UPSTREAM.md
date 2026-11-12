# Origin

Vendored from **floci-cli** — https://github.com/floci-io/floci-cli — at commit
`ae4bf9935280e98d713281666a8cf920db9e3ea8` (2026-11-12, upstream version **0.4.0**).

- Skill version: **0.4.0** (the release that ships `skills/floci/`).
- License: **MIT**, © 2024 Floci Contributors (`LICENSE`, kept verbatim).
- Vendored on: **2026-11-12**, from a shallow `git fetch --depth 1` of that SHA.
- Upstream size: 17 files, about 108 KB on disk; the 16 kept files are 77,425 bytes.

## Vendored files

Copied from the upstream `skills/floci/` directory:

- `SKILL.md`.
- `references/` — `aws.md`, `azure.md`, `ci.md`, `docker.md`, `docs.md`, `gcp.md`,
  `namespaces.md`, `oci.md`, `troubleshooting.md` (9 files).
- `assets/compose/` — `aws.yml`, `azure.yml`, `gcp.yml`, `multi-cloud.yml`, `oci.yml`
  (5 files).
- `scripts/ensure-running.sh`.

Excluded from upstream:

- `scripts/install-floci.sh` — the remote installer (downloads and runs a release script).

Added at the skill root: `LICENSE`, this `UPSTREAM.md`.

## Local modifications

- Removed `scripts/install-floci.sh`; the kit vendors the skill only and installs nothing.
- Rewrote the `Prerequisites` install section of `SKILL.md`: install `floci` yourself with
  Homebrew or a pinned release whose sha256 is verified. No remote installer is piped into
  a shell, and the kit does not install the CLI.
- Rewrote the install recipes in `references/ci.md` (generic pipeline and GitHub Actions) to
  use Homebrew or a preinstalled, checksum-verified `floci`; added a note to pin the CI
  container image by tag or digest instead of relying on `latest`.
- Rewrote the missing-CLI message in `scripts/ensure-running.sh` so it no longer points at
  the removed installer.

No other content was changed. Upstream paths and examples were kept as-is.

## Risks

- **Docker socket mounts**: the Compose assets mount `/var/run/docker.sock` into the
  emulator containers. A process with that socket can control the host Docker daemon
  (create privileged containers, read host volumes).
- **Floating images**: the Compose assets and some references use `:latest` tags, so a pull
  can silently change the emulator version.
- **User config writes**: `floci az setup`, `floci oci setup` and the CLI itself write under
  `~/.floci` (profiles, per-instance state, persisted data) and `~/.oci/config` (a `[FLOCI]`
  profile and a throwaway key). Azure setup also changes the user's `az` cloud registration.
- **Local endpoints are not authentication**: the emulators accept fake credentials; the
  Compose templates publish them on `127.0.0.1` only. Publishing a port on `0.0.0.0` would
  expose an unauthenticated cloud API to the network.
- The skill has no checksum-pinned binary or image of its own; nothing is verified
  automatically at install time.

## Mitigations

- Pin container images by digest (or at least a release tag) in real projects and in CI;
  do not copy `:latest` unchanged.
- Mount `/var/run/docker.sock` only for services that really launch child containers
  (Lambda, ECS, RDS, Functions, OKE); drop the mount and the socket volume otherwise.
- Keep every published port on loopback and use the fake credentials only.
- Prefer `--persist` directories inside the project or a dedicated `~/.floci` path, and
  review `~/.oci/config` after `floci oci setup` if the user already has OCI profiles.
- Install the CLI from a pinned release with a verified sha256 (or Homebrew), never from a
  remote installer piped into a shell.
