// Ambient stubs for the modules the Pi host provides at runtime.
//
// The Pi extension is published as a standalone npm package whose peerDependencies
// (@earendil-works/pi-coding-agent, @earendil-works/pi-tui, typebox) are resolved from Pi's own
// install — they are deliberately NOT dependencies of this repo (scripts/build-pi-package.ts
// explains why). `npm run typecheck:pi` still has to resolve them, so they are declared here as
// untyped host modules: the check covers this repo's own logic, not the Pi SDK's surface.
//
// Only used by tsconfig.pi.json; never shipped (build:pi copies asaki-memory.ts alone).
declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = any;
  const value: any;
  export default value;
}

declare module "@earendil-works/pi-tui" {
  export const Text: any;
  const value: any;
  export default value;
}

declare module "typebox" {
  export const Type: any;
  const value: any;
  export default value;
}
