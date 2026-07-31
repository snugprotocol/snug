// ESM shim for "react/jsx-runtime" on top of the UMD global (the runner's compiled
// dist imports the automatic JSX runtime). Children arrays are spread so keyed lists
// behave the same as with the real runtime.
const React = window.React;

function make(type, props, key) {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) rest.key = key;
  if (children === undefined) return React.createElement(type, rest);
  return Array.isArray(children)
    ? React.createElement(type, rest, ...children)
    : React.createElement(type, rest, children);
}

export const Fragment = React.Fragment;
export const jsx = make;
export const jsxs = make;
export const jsxDEV = make;
