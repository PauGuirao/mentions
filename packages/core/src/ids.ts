/** Prefixed, sortable-enough ids (crypto UUID body). One helper so every
 *  table's id shape is uniform and greppable: kw_, men_, mm_, feed_, dest_,
 *  del_, org_, key_. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}
