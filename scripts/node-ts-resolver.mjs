import { registerHooks } from 'node:module';

// Node ESM resolve hook for the offline evals.
//
// src/** uses extensionless relative imports (wrangler/esbuild resolve them, and tsconfig's
// "Bundler" moduleResolution type-checks them), but `node --experimental-strip-types` needs a
// concrete file. Retry a failed relative resolve with a `.ts` suffix so an eval can import a src
// module that has runtime — not just type-only — imports of its siblings.
export function registerTsResolver() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });
}
