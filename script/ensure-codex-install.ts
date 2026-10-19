import { createHash } from "node:crypto"
import { relative } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildCodexInstaller,
  bundledWorkspaceSources,
  digestCodexInstallerSources,
  generatedCodexInstallerPath,
  parseCodexInstallerArtifact,
} from "./build-codex-install"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

// `bun run build` keeps a bundle whose marker matches the current sources byte-for-byte.
// Rebuilding it with a different local Bun changes only the emitted bytes, so the build would
// churn the tracked file without any installer source change. `bun run build:codex-install`
// still regenerates unconditionally. This check lives outside build-codex-install.ts because
// that file is part of the source digest: editing it marks every committed bundle stale.
export async function isCodexInstallerArtifactCurrent(text: string): Promise<boolean> {
  const artifact = parseCodexInstallerArtifact(text)
  if (artifact === undefined) return false
  if (createHash("sha256").update(artifact.body).digest("hex") !== artifact.bodyDigest) return false
  return (await digestCodexInstallerSources(bundledWorkspaceSources(artifact.body))) === artifact.sourceDigest
}

if (import.meta.main) {
  try {
    const committed = Bun.file(generatedCodexInstallerPath)
    if ((await committed.exists()) && (await isCodexInstallerArtifactCurrent(await committed.text()))) {
      console.log(`Codex installer bundle is current; kept ${relative(repositoryRoot, generatedCodexInstallerPath)}`)
    } else {
      await buildCodexInstaller()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
