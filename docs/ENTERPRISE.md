# OCX Enterprise Features

OCX is designed to be reliable in professional environments where supply-chain security and configuration stability are critical.

## Registry Locking

In team environments, you may want to prevent developers from adding unapproved registry sources. You can enable `lockRegistries` in `ocx.jsonc`:

```jsonc
{
  "registries": {
    "internal": { "url": "https://registry.corp.com" }
  },
  "lockRegistries": true
}
```

When `lockRegistries` is `true`, `ocx registry add` and `ocx registry remove` will fail. This configuration should be checked into your version control system.

> **Note:** The `lockRegistries` setting applies to the config file where it's defined. If set in your global config (`~/.config/opencode/ocx.jsonc`), it prevents `ocx registry add --global` and `ocx registry remove --global` from modifying global registries. If set in a local project config, it only affects local registry operations. When using profiles, `lockRegistries` in a profile's `ocx.jsonc` locks that profile's registries.

## Version Pinning

You can pin a registry to a specific version to ensure reproducible environments:

```bash
ocx registry add https://registry.kdco.dev --version 0.1.0
```

This ensures that `ocx add` and updates will only pull components compatible with version `0.1.0` of that registry.

## Security Audit with `ocx.lock`

OCX automatically generates an `ocx.lock` file. This file acts as an audit log and integrity check for your installed extensions.

| Field | Purpose |
|-------|---------|
| `registry` | Tracks exactly which source provided the component. |
| `version` | Records the specific version installed. |
| `hash` | SHA-256 hash of the component files. OCX uses this to detect manual tampering during `ocx diff`. |
| `files` | Array of file paths installed by this component. |
| `installedAt` | ISO timestamp of the installation. |

## Integrity Verification

OCX provides both proactive and reactive integrity verification to protect against supply-chain attacks and accidental tampering.

### Install-Time Verification (Proactive)

When you run `ocx add`, OCX automatically verifies the integrity of the component before writing any files to your project. If a component is already present in your `ocx.lock` file, OCX computes the SHA-256 hash of the incoming content and compares it against the locked hash.

If the hashes do not match, the installation fails immediately with an `INTEGRITY_ERROR`. This prevents malicious or unauthorized updates from silently entering your codebase even if a registry is compromised.

### Intentional Updates

The `IntegrityError` is a security feature, not a bug. When you need to update a component whose source has changed, use the dedicated `ocx update` command:

```bash
# Preview what will change
ocx update kdco/agents --dry-run

# Apply the update
ocx update kdco/agents

# Update all components
ocx update --all --dry-run
ocx update --all
```

This explicit workflow ensures that component updates are always intentional and auditable.

### Component Version Pinning

Pin components to specific audited versions using the `@version` syntax:

```bash
# Pin to a security-audited version
ocx update kdco/agents@1.2.0

# Add a component at a specific version
ocx add kdco/agents@1.2.0
```

This ensures reproducible deployments with known-good versions that have passed your security review.

### Update Audit Trail

The lock file tracks the complete update history for each component:

```jsonc
{
  "kdco/agents": {
    "version": "1.2.0",
    "hash": "sha256-...",
    "installedAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-04T00:00:00.000Z"  // Tracks last update
  }
}
```

Use `ocx diff` to review changes before updating. The combination of `updatedAt` timestamps and hash verification provides a complete audit trail for compliance and security reviews.

### Security Audit with `ocx diff` (Reactive)

Running `ocx diff` compares your local files against the upstream registry and uses the hash in `ocx.lock` to identify changes. This allows teams to audit exactly what modifications have been made to distributed agents or plugins.

## Air-Gapped Environments

Since OCX is a single binary and registries are simple static JSON files, you can easily mirror registries internally and point OCX to local network URLs.

## CLI Binary Verification

When running `ocx self update`, OCX verifies the downloaded binary against the published SHA256SUMS.txt file in GitHub Releases. This protects against:

- Compromised CDN/mirror serving malicious binaries
- Man-in-the-middle attacks during download
- Tampered releases

### Disabling Update Notifications

Control update checks via environment variables:

| Variable | Value | Behavior |
|----------|-------|----------|
| `OCX_SELF_UPDATE` | `off` | Disable all update checks |
| `OCX_NO_UPDATE_CHECK` | `1` | Disable all update checks (alternative) |

```bash
# Disable permanently in shell profile
export OCX_SELF_UPDATE=off

# Disable for single command
OCX_SELF_UPDATE=off ocx add button
```

Update checks are automatically disabled in CI environments.

### Internal Binary Hosting

For air-gapped or restricted environments, you can mirror OCX releases internally:

1. Download releases from GitHub to your internal server
2. Include the SHA256SUMS.txt file for integrity verification
3. Set `OCX_DOWNLOAD_URL` environment variable to your internal mirror URL

```bash
export OCX_DOWNLOAD_URL="https://internal.corp.com/ocx/releases"
ocx self update
```

The URL should point to a directory structure matching GitHub releases:

```
https://internal.corp.com/ocx/releases/
├── v1.0.0/
│   ├── ocx-darwin-arm64
│   ├── ocx-darwin-x64
│   ├── ocx-linux-arm64
│   ├── ocx-linux-x64
│   ├── ocx-windows-x64.exe
│   └── SHA256SUMS.txt
└── v1.0.1/
    └── ...
```

The download URL is constructed as `${OCX_DOWNLOAD_URL}/v${version}/${binary-name}`, where binary names match the platform (e.g., `ocx-darwin-arm64` for macOS ARM64).
