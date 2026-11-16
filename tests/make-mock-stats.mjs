/**
 * Generates a deterministic, realistic stats fixture for the local UI harness.
 * Run: node tests/make-mock-stats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MATCHER = require('../src/lib/matcher.js');
const STATS = require('../src/lib/stats.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TAGS = [
  'implementation', 'math', 'greedy', 'dp', 'data structures', 'brute force',
  'constructive algorithms', 'graphs', 'sortings', 'binary search', 'dfs and similar',
  'trees', 'strings', 'number theory', 'combinatorics', 'geometry',
  'two pointers', 'bitmasks', 'games', 'shortest paths',
];
const SUBJECTS = [
  'Ancient', 'Binary', 'Cosmic', 'Distant', 'Elegant', 'Frozen', 'Golden', 'Hidden',
  'Infinite', 'Jagged', 'Keen', 'Lunar', 'Mystic', 'Narrow', 'Odd', 'Parallel',
  'Quiet', 'Rapid', 'Silent', 'Tiny', 'Urban', 'Vivid', 'Warm', 'Young', 'Zesty',
  'Amber', 'Bright', 'Crimson', 'Daring', 'Emerald', 'Fragile', 'Gentle', 'Hollow',
  'Ivory', 'Jolly', 'Kindred', 'Lively', 'Mellow', 'Noble', 'Opal',
];
const OBJECTS = [
  'Array', 'Tree', 'Graph', 'String', 'Matrix', 'Garden', 'River', 'Mountain',
  'Sequence', 'Kingdom', 'Puzzle', 'Journey', 'Castle', 'Forest', 'Island',
  'Machine', 'Network', 'Portal', 'Queue', 'Segment', 'Tower', 'Valley', 'Window',
  'Crystal', 'Bridge', 'Library', 'Planet', 'Signal', 'Voyage', 'Workshop',
];

function titleFor(index) {
  return SUBJECTS[index % SUBJECTS.length] + ' ' +
    OBJECTS[Math.floor(index / SUBJECTS.length) % OBJECTS.length];
}

function hash01(value) {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function cfRatingFor(index) {
  const value = hash01(index + 1);
  let rating;
  if (value < 0.5) rating = 800 + (value / 0.5) * 500;
  else if (value < 0.82) rating = 1300 + ((value - 0.5) / 0.32) * 800;
  else if (value < 0.96) rating = 2100 + ((value - 0.82) / 0.14) * 800;
  else rating = 2900 + ((value - 0.96) / 0.04) * 600;
  return Math.max(800, Math.min(3500, Math.round(rating / 100) * 100));
}

function atCoderDifficultyFor(index) {
  const value = hash01(index + 500);
  let difficulty;
  if (value < 0.45) difficulty = 0 + (value / 0.45) * 800;
  else if (value < 0.8) difficulty = 800 + ((value - 0.45) / 0.35) * 800;
  else if (value < 0.95) difficulty = 1600 + ((value - 0.8) / 0.15) * 1000;
  else difficulty = 2600 + ((value - 0.95) / 0.05) * 800;
  return Math.max(0, Math.min(3400, Math.round(difficulty)));
}

const cfProblems = [];
for (let i = 0; i < 1000; i += 1) {
  const rating = cfRatingFor(i);
  const tags = [
    TAGS[i % TAGS.length],
    TAGS[(i * 7 + 3) % TAGS.length],
    TAGS[(i * 11 + 5) % TAGS.length],
  ].filter((tag, index, array) => array.indexOf(tag) === index).slice(0, i % 3 === 0 ? 3 : 2);
  cfProblems.push({
    contestId: 1000 + i,
    index: 'A',
    name: titleFor(i),
    rating,
    tags,
  });
}

const atcoderProblems = [];
for (let i = 0; i < 120; i += 1) {
  atcoderProblems.push({
    id: 'mock_abc_' + i,
    contestId: 'abc' + (200 + i),
    index: 'A',
    name: 'AtCoder Task ' + String.fromCharCode(65 + (i % 20)) + ' ' + (100 + i),
    difficulty: atCoderDifficultyFor(i),
  });
}

const solved = [];
let ts = 1600000000;

// Official problems.
for (let i = 0; i < 800; i += 1) {
  const problem = cfProblems[i];
  solved.push({
    c: problem.contestId,
    i: problem.index,
    n: problem.name,
    r: problem.rating,
    t: problem.tags,
    ts: ts += 37,
  });
}

// Gym copies of already solved official problems (changed index/display name).
for (let i = 0; i < 150; i += 1) {
  const problem = cfProblems[i * 3];
  solved.push({
    c: 104000 + i,
    i: 'B',
    n: 'B. ' + problem.name,
    t: [],
    ts: ts += 41,
  });
}

// Gym tasks renamed with a qualifier: matched by the CF fuzzy matcher.
for (let i = 0; i < 30; i += 1) {
  const problem = cfProblems[850 + i];
  solved.push({
    c: 105000 + i,
    i: 'C',
    n: problem.name + ' (Gym)',
    t: [],
    ts: ts += 53,
  });
}

// AtCoder tasks mirrored in gyms.
for (let i = 0; i < 60; i += 1) {
  const problem = atcoderProblems[i];
  solved.push({
    c: 106000 + i,
    i: 'D',
    n: problem.name,
    t: [],
    ts: ts += 61,
  });
}

// Tasks that exist in neither archive.
for (let i = 0; i < 40; i += 1) {
  solved.push({
    c: 107000 + i,
    i: 'E',
    n: 'External Problem ' + String.fromCharCode(65 + (i % 26)) + ' ' + (i + 1),
    t: [TAGS[i % TAGS.length]],
    ts: ts += 47,
  });
}

const catalog = MATCHER.buildCatalog(cfProblems, atcoderProblems);
const stats = STATS.buildStats({
  handle: 'demo_user',
  solved,
  catalog,
  totalSubmissions: 2784,
  fetchedAt: Date.now() - 4 * 60 * 1000,
  settings: { topTags: 12, recentLimit: 5, fuzzyMatching: true, atcoderEnabled: true },
  meta: {
    cfArchive: { fetchedAt: Date.now() - 3 * 60 * 60 * 1000, fromCache: true, stale: false },
    atcoderArchive: { fetchedAt: Date.now() - 5 * 60 * 60 * 1000, fromCache: true, stale: false, enabled: true },
  },
  warnings: [],
});

stats.archives.codeforces.count = 10000;
stats.archives.atcoder.count = 9959;
stats.performance = {
  elapsedMs: 218,
  statusFromCache: true,
  cfArchiveFromCache: true,
  atcoderArchiveFromCache: true,
  atcoderDisabled: false,
  statusTruncated: false,
  statusPages: 1,
};
stats.version = '1.0.0';
stats.isStale = false;

const output = 'window.CFS_MOCK_STATS = ' + JSON.stringify(stats, null, 2) + ';\n';
fs.mkdirSync(path.join(root, 'tests', 'harness'), { recursive: true });
fs.writeFileSync(path.join(root, 'tests', 'harness', 'mock-stats.js'), output, 'utf8');
console.log('Wrote tests/harness/mock-stats.js');
console.log(JSON.stringify({
  totalSolved: stats.totalSolved,
  sourceCounts: stats.sourceCounts,
  training: stats.training,
  tags: stats.tags.items.length,
  recent: stats.recent.length,
}, null, 2));
