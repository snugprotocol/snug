// The `?raw` import of the instructions text (D-B12). Vite inlines the file at build time;
// `vite/client` declares this globally, but this package does not take that whole type
// surface (it is a Node process, not a browser bundle), so the one form it uses is declared
// here.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
