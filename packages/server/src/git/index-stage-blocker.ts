import type { GitFileChange } from '@glink/protocol/git';

/** Renames affect both paths; untracked embedded repositories use a trailing slash. */
export function indexStageBlocker(
  file: GitFileChange,
  blockers: ReadonlyMap<string, Error> | undefined,
) {
  return blockers?.get(file.path.replace(/\/$/, ''))
    ?? (file.originalPath ? blockers?.get(file.originalPath.replace(/\/$/, '')) : undefined);
}
