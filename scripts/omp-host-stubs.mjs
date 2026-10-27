// Module-resolution hooks that let the eval import the real OMP extension source.
// OMP host packages are intentionally not installed as runtime dependencies in this repository.
// These minimal modules let the test exercise the native ExtensionAPI registration contract.
import { register, registerHooks } from 'node:module';
const STUBS = {
  '@oh-my-pi/pi-tui': new URL('./omp-host-stubs-tui.mjs', import.meta.url).href,
};

export function registerOmpHostStubs() {
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
  register(new URL('./omp-host-stubs-loader.mjs', import.meta.url));
}

// Off-thread loader entry point (see the fallback above); also the shape `register()` expects.
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, format: 'module', shortCircuit: true };
  return next(specifier, context);
}
