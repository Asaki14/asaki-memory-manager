// Runtime stub for `typebox`, used only by scripts/eval-pi-inject.mjs via
// scripts/pi-host-stubs.mjs. The extension calls Type.Object/String/Number/... at import time to
// declare tool schemas; the eval never validates against them, so each call just returns a marker.
const handler = {
  get(_target, key) {
    return (...args) => ({ typebox: String(key), args });
  },
};
export const Type = new Proxy({}, handler);
