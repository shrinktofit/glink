/** A view snapshot of real node IDs, including descendants of collapsed nodes. */
export type ExpansionState = Readonly<Record<string, boolean>>;

export function equalExpansionState(a: ExpansionState, b: ExpansionState) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}
