// Pi half of `npm run eval:inject-env`: runs the same parameterized table as the bash halves
// against the SHIPPED `// #region asaki-env-parse` block of integrations/pi/asaki-memory.ts, so
// the contract is asserted at runtime and not merely typechecked.
import { loadPiEnvParsers } from './pi-trace-region.mjs';

const { module, dispose } = await loadPiEnvParsers();
const {
  parsePositiveIntEnv,
  parseUnitScoreEnv,
  AUTO_INJECT_TOP_K_DEFAULT,
  AUTO_INJECT_TOP_K_CAP,
  PROJECT_DIGEST_MAX_CAP,
  PROJECT_DIGEST_MAX_CHARS_CAP,
  PROJECT_DIGEST_CONTENT_CHARS_CAP,
} = module;

const failures = [];
let checks = 0;

function check(label, expected, actual) {
  checks += 1;
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The four (default, cap) pairs, read from the shipped constants where they exist.
const variants = [
  { name: 'topK', def: AUTO_INJECT_TOP_K_DEFAULT, cap: AUTO_INJECT_TOP_K_CAP },
  { name: 'digestMax', def: 10, cap: PROJECT_DIGEST_MAX_CAP },
  { name: 'maxChars', def: 3000, cap: PROJECT_DIGEST_MAX_CHARS_CAP },
  { name: 'contentChars', def: 240, cap: PROJECT_DIGEST_CONTENT_CHARS_CAP },
];

check('constants: topK default', 6, AUTO_INJECT_TOP_K_DEFAULT);
check('constants: topK cap', 20, AUTO_INJECT_TOP_K_CAP);
check('constants: digestMax cap', 50, PROJECT_DIGEST_MAX_CAP);
check('constants: maxChars cap', 20000, PROJECT_DIGEST_MAX_CHARS_CAP);
check('constants: contentChars cap', 2000, PROJECT_DIGEST_CONTENT_CHARS_CAP);

const HUGE = '9'.repeat(42);
// raw -> [topK(6,20), digestMax(10,50), maxChars(3000,20000), contentChars(240,2000)]
const intTable = [
  ['8', [8, 8, 8, 8]],
  ['99', [20, 50, 99, 99]],
  ['0', [6, 10, 3000, 240]],
  ['-1', [6, 10, 3000, 240]],
  ['abc', [6, 10, 3000, 240]],
  ['8junk', [6, 10, 3000, 240]],
  ['1.5', [6, 10, 3000, 240]],
  ['.', [6, 10, 3000, 240]],
  ['1.2.3', [6, 10, 3000, 240]],
  ['', [6, 10, 3000, 240]],
  ['   ', [6, 10, 3000, 240]],
  ['007', [7, 7, 7, 7]],
  ['000', [6, 10, 3000, 240]],
  [' 12 ', [12, 12, 12, 12]],
  ['20', [20, 20, 20, 20]],
  ['21', [20, 21, 21, 21]],
  ['50', [20, 50, 50, 50]],
  ['51', [20, 50, 51, 51]],
  ['20000', [20, 50, 20000, 2000]],
  ['20001', [20, 50, 20000, 2000]],
  [HUGE, [20, 50, 20000, 2000]],
  [undefined, [6, 10, 3000, 240]],
  [null, [6, 10, 3000, 240]],
  [Infinity, [6, 10, 3000, 240]],
  [8, [8, 8, 8, 8]],
  [-1, [6, 10, 3000, 240]],
];

for (const [raw, expected] of intTable) {
  variants.forEach((variant, index) => {
    check(`pi int ${variant.name} raw=${JSON.stringify(raw)}`, expected[index], parsePositiveIntEnv(raw, variant.def, variant.cap));
  });
}

const scoreTable = [
  ['0', 0],
  ['1', 1],
  ['0.67', 0.67],
  ['.67', 0.67],
  ['1.0', 1],
  ['0.0', 0],
  ['00.5', 0.5],
  [' 0.8 ', 0.8],
  ['-0.1', 0.67],
  ['1.1', 0.67],
  ['2', 0.67],
  ['abc', 0.67],
  ['', 0.67],
  ['   ', 0.67],
  ['Infinity', 0.67],
  ['.', 0.67],
  ['1.2.3', 0.67],
  ['0.67x', 0.67],
  [undefined, 0.67],
  [null, 0.67],
  [0.42, 0.42],
  [-0.1, 0.67],
  [1.1, 0.67],
  [Infinity, 0.67],
  [NaN, 0.67],
];

for (const [raw, expected] of scoreTable) {
  check(`pi score raw=${JSON.stringify(raw)}`, expected, parseUnitScoreEnv(raw, 0.67));
}

// Every accepted score must be a number the server accepts (it 400s outside [0,1]).
for (const [raw] of scoreTable) {
  const value = parseUnitScoreEnv(raw, 0.67);
  checks += 1;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    failures.push(`pi score raw=${JSON.stringify(raw)}: ${value} is outside the server's [0,1] range`);
  }
}

dispose();

console.log(`inject-env eval (pi): ${checks} checks, ${failures.length} failure(s)`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`- FAIL ${failure}`);
  process.exit(1);
}
