# Origin

Vendored from **floci-cli** — https://github.com/floci-io/floci-cli — at commit
`5306c3c1a5cfd52f8f6a6e0fa2e56442a38f7ac9` (tag `1.0.0`, released 2026-11-19).

- Skill version: CLI release **1.0.0**. The upstream plugin manifest at that commit
  (`plugin.json`, not vendored) declares plugin version **1.0.6**: upstream versions the
  plugin separately from the CLI release, which is why the vendored subset carries no
  version string of its own.
- License: **MIT**, © 2024 Floci Contributors (`LICENSE`, kept verbatim).
- Vendored on: **2026-11-12** at `ae4bf9935280e98d713281666a8cf920db9e3ea8` (0.4.0);
  refreshed on **2026-11-28** to `5306c3c1` (1.0.0) from the tag tarball, files compared
  byte-for-byte against the raw blobs.
- Upstream size at 1.0.0: 17 files, 80,729 bytes; the 16 kept files are 77,559 bytes.
- Refresh scope: the GitHub compare API reports 5 commits between `ae4bf99` and
  `5306c3c1`; within `skills/floci/` only `references/troubleshooting.md` changed
  (+2 lines on the macOS `podman machine` socket). The other changes are CLI sources,
  tests, CI, `README.md`, `CHANGELOG.md`, `pom.xml` and `plugin.json`, none of which the
  kit vendors.

## Vendored files

Copied from the upstream `skills/floci/` directory:

- `SKILL.md`.
- `references/` — `aws.md`, `azure.md`, `ci.md`, `docker.md`, `docs.md`, `gcp.md`,
  `namespaces.md`, `oci.md`, `troubleshooting.md` (9 files). `troubleshooting.md` is the
  1.0.0 revision, byte-identical to upstream (5,515 bytes, sha256
  `e8968839c73c636108972f0cbd0073148a80b6fe974e7a5bf70e0bdb13d4d2c0`).
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

No other content was changed. Upstream paths and examples were kept as-is. The 1.0.0
refresh replaced only `references/troubleshooting.md`; the safety edits above are
unchanged.

## Risks

- **Docker socket mounts (root-equivalent)**: every Compose asset mounts
  `/var/run/docker.sock` into the emulator container by default. Access to that socket
  is equivalent to root on the host: a process can start privileged containers, mount
  any host path and read or modify host data. Treat any container with that mount as
  trusted as the host itself. Comment the volume out unless the service under test
  needs the Functions or OKE emulation, which launches child containers.
- **Floating images (`:latest`)**: all five Compose assets and several references use
  `:latest`, so a pull can silently change the code that runs next to that socket and
  inside your project. A mutable tag is not a supply-chain control.
- **User config writes**: `floci az setup`, `floci oci setup` and the CLI itself write under
  `~/.floci` (profiles, per-instance state, persisted data) and `~/.oci/config` (a `[FLOCI]`
  profile and a throwaway key). Azure setup also changes the user's `az` cloud registration.
- **Local endpoints are not authentication**: the emulators accept fake credentials; the
  Compose templates publish them on `127.0.0.1` only. Publishing a port on `0.0.0.0` would
  expose an unauthenticated cloud API to the network.
- The skill has no checksum-pinned binary or image of its own; nothing is verified
  automatically at install time.

## Mitigations

- Pin every container image **by digest** (`floci/floci@sha256:…`) in real projects and
  in CI; a release tag is the strict minimum, and `:latest` must not be deployed. Review
  the digest when bumping the emulator.
- Keep `/var/run/docker.sock` **commented out** in the copied Compose file unless the
  service under test needs Functions or OKE; those are the features that launch child
  containers. Without the mount, the other emulators still run, and the container no
  longer has root-equivalent control of the host daemon.
- Keep every published port on loopback and use the fake credentials only.
- Prefer `--persist` directories inside the project or a dedicated `~/.floci` path, and
  review `~/.oci/config` after `floci oci setup` if the user already has OCI profiles.
- Install the CLI from a pinned release with a verified sha256 (or Homebrew), never from a
  remote installer piped into a shell.
