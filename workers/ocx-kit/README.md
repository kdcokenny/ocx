# Frozen OCX Kit registry

This worker serves OCX 2 / OpenCode V1 artifacts only. `bun run build` restores and verifies `../../legacy/ocx-kit.tar.gz`. The old `ws` and `omo` profile URLs retain their original bytes.

New OpenCode V2 profiles belong to the single KDCO `/opencode-v2/` catalog. Do not add active profile generators, runtime SDK dependencies, or plugin synchronization here.
