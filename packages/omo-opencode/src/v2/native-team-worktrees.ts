import path from "node:path"

export type NativeTeamWorktree = { readonly projectID: string; readonly directory: string }

export type NativeWorktreeDomain = {
  readonly create: (input: { readonly projectID: string; readonly from: string; readonly directory: string; readonly name: string }) => Promise<{ readonly directory: string }>
  readonly list: (input: { readonly projectID: string }) => Promise<readonly { readonly directory: string }[]>
  readonly remove: (input: NativeTeamWorktree & { readonly force: boolean }) => Promise<void>
}

export type NativeTeamWorktrees = {
  readonly create: (directory: string) => Promise<NativeTeamWorktree>
  readonly remove: (identity: NativeTeamWorktree) => Promise<void>
}

const owners = new WeakMap<object, NativeTeamWorktrees>()

export function bindNativeTeamWorktrees(owner: object, worktrees: NativeTeamWorktrees): void {
  owners.set(owner, worktrees)
}

export function getNativeTeamWorktrees(owner: object | undefined): NativeTeamWorktrees | undefined {
  return owner ? owners.get(owner) : undefined
}

export function createNativeTeamWorktrees(context: {
  readonly worktree?: NativeWorktreeDomain
  readonly location: { readonly directory: string; readonly project: { readonly id: string } }
}): NativeTeamWorktrees {
  return {
    create: async (directory) => {
      if (!context.worktree) throw new Error("Native team worktrees require the host worktree domain")
      const projectID = context.location.project.id
      const created = await context.worktree.create({
        projectID, from: context.location.directory, directory: path.dirname(directory), name: path.basename(directory),
      })
      return { projectID, directory: created.directory }
    },
    remove: async (identity) => {
      if (!context.worktree) throw new Error("Native team worktrees require the host worktree domain")
      const entries = await context.worktree.list({ projectID: identity.projectID })
      if (entries.some((entry) => entry.directory === identity.directory)) {
        await context.worktree.remove({ ...identity, force: true })
      }
    },
  }
}
