// Off-thread loader shim for scripts/pi-host-stubs.mjs's fallback path (nodes without
// module.registerHooks). It only re-exports the resolve hook defined there.
export { resolve } from './pi-host-stubs.mjs';
