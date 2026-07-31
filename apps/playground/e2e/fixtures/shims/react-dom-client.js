// ESM shim: maps "react-dom/client" onto the UMD global loaded by harness.html.
const ReactDOM = window.ReactDOM;
export const createRoot = ReactDOM.createRoot;
export const hydrateRoot = ReactDOM.hydrateRoot;
export default { createRoot, hydrateRoot };
