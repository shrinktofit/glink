export interface FileTreeEntry {
  path: string;
}

export function fileTreePathsOverlap(first: string, second: string) {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}
