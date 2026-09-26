// Vite (and so vitest) can import a file's source as a string with ?raw. There
// are no Node types in this project on purpose — "types" is pinned to
// @cloudflare/workers-types so nobody reaches for a Node API the Worker runtime
// does not have — so this is how a test reads a file it wants to assert on.
declare module "*?raw" {
  const content: string;
  export default content;
}
