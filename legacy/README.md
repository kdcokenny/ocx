# Frozen OpenCode V1 artifacts

These archives are the built registries from OCX source commit `e79df6f` (CLI source version `2.0.15`). Their original URLs remain served by the existing workers. The active V2 catalog lives at `/opencode-v2/` on the KDCO registry.

`manifest.json` records every file hash and archive hash. Worker builds restore and verify these bytes before building the separate new catalog. No V1 plugin code is rebuilt with the new CLI. Historical source remains in Git; packages, tags, and releases are not unpublished.

The frozen CLI installation is `bun add --global ocx@2.0.15`. It requires OpenCode V1. OCX 3 requires OpenCode V2. New major releases must remain on the preview channel until the legacy updater and installer paths have been reviewed; old binaries cannot retroactively understand a new channel.

For rollback, retain the original OCX files **and an OpenCode V1 executable**. V1 and V2 normally share the `opencode` command.
