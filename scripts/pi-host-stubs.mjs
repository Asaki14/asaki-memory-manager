// Module-resolution hooks that let an eval import integrations/pi/asaki-memory.ts for real.
//
// The extension is a single shipped file that imports Pi host modules (`@earendil-works/pi-tui`,
// `typebox`) which are peer dependencies resolved by Pi, not dependencies of this repo — see
// tsconfig.pi.json / integrations/pi/pi-host-modules.d.ts for the typecheck-side equivalent.
// registerPiHostStubs() maps those specifiers to the minimal runtime stubs next to this file so
// the extension module (and its `export default function (pi)` wiring) can be exercised
// end-to-end. Nothing else is redirected.
import { register, registerHooks } from 'node:module';

const STUBS = {
  '@earendil-works/pi-tui': new URL('./pi-host-stubs-tui.mjs', import.meta.url).href,
  '@earendil-works/pi-coding-agent': new URL('./pi-host-stubs-tui.mjs', import.meta.url).href,
  typebox: new URL('./pi-host-stubs-typebox.mjs', import.meta.url).href,
};

export function registerPiHostStubs() {
  // Synchronous in-thread hooks where available (node >= 22.15); the older off-thread loader is
  // the fallback so this keeps working on a node that predates registerHooks.
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, next) {
        const stub = STUBS[specifier];
        if (stub) return { url: stub, format: 'module', shortCircuit: true };
        return next(specifier, context);
      },
    });
    return;
  }
  register(new URL('./pi-host-stubs-loader.mjs', import.meta.url));
}

// Off-thread loader entry point (see the fallback above); also the shape `register()` expects.
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, format: 'module', shortCircuit: true };
  return next(specifier, context);
}
