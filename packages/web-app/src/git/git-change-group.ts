import type { GitFileChange } from '@glink/protocol/git';

export interface GitChangeGroup {
  id: string;
  repoPath: string;
  files: readonly GitFileChange[];
}
