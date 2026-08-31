/**
 * The two helpers every view in the editor is built from.
 *
 * Extracted so the scenario half and the workshop half can share them without
 * either importing the other — they are separate concerns that happen to run in
 * the same page.
 */

export const $ = (id) => document.getElementById(id);

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  // Deep, not one level: rows are built from arrays of [separator, element]
  // pairs, and a half-flattened array stringifies to "[object HTMLElement]".
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'object' ? child : String(child));
  }
  return node;
}

/**
 * A labelled row: `in  → a, b`.
 *
 * Here rather than in either view because the Nodes tab and the simulator both
 * draw one, and two copies of a three-line helper is how two views start
 * disagreeing about their own gutter width.
 */
export function flowRow(key, ...content) {
  return h(
    'div',
    { class: 'flow' },
    h('span', { class: 'flow-key' }, key),
    h('span', { class: 'flow-val' }, ...content),
  );
}
