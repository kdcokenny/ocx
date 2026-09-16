# Registry author guidance

Use OCX 3 registry protocol 3 and OpenCode V2 files. Components copy files; do not add npm dependency fields or native config patches. Only profile recipes may own root config files. Keep supporting assets beside their skill files and use root-relative targets without `.opencode/`.

Run `bun run build` and `bunx ocx@next validate .` before publication. Keep a separate immutable endpoint for legacy clients. See https://ocx.kdco.dev/v2/registries for the format.
