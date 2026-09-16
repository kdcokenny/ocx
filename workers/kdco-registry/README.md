# KDCO registry worker

`bun run build` restores the verified legacy registry from `../../legacy/kdco-registry.tar.gz`, preserving its existing URLs, then builds the file-only catalog under `/opencode-v2/`. New source lives in `catalog/`; it contains a minimal native profile and a review skill.

Do not regenerate legacy files from OCX 3 or move new components onto old URLs. See `../../legacy/manifest.json` for provenance and `../../docs/v2/registries.mdx` for protocol 3. Runtime plugin source is retired.
