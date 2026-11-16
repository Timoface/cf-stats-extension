import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../src/lib/normalize.js');
const MATCHER = require('../src/lib/matcher.js');
const STATS = require('../src/lib/stats.js');
const SETTINGS = require('../src/lib/settings.js');
const API = require('../src/lib/api.js');
const SCRAPE = require('../src/lib/scrape.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('  FAIL ' + name + '\n       ' + (error && error.message));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((message || 'values differ') + ':\n  expected ' + b + '\n  got      ' + a);
  }
}

function section(title) {
  console.log('\n' + title);
}

section('Normalization');
test('strips common problem-index prefixes', () => {
  equal(N.normalizeTitle('A. Watermelon'), 'watermelon');
  equal(N.normalizeTitle('G2) Lakeside Trail'), 'lakeside trail');
  equal(N.normalizeTitle('Problem C — Extra Road'), 'extra road');
  equal(N.normalizeTitle('Задача D. Сумма'), 'сумма');
});

test('does not strip "A + B" style titles', () => {
  equal(N.normalizeTitle('A + B'), 'a b');
  equal(N.normalizeTitle('A + B > C ?'), 'a b c');
});

test('normalizes punctuation, apostrophes and diacritics', () => {
  equal(N.normalizeTitle("DEGwer's Doctoral Dissertation"), 'degwers doctoral dissertation');
  equal(N.normalizeTitle('Café & Bar'), 'cafe and bar');
  equal(N.normalizeTitle('Hello, World!'), 'hello world');
});

test('tokenization drops stopwords and duplicates', () => {
  deepEqual(N.tokenize('the array and the array of life'), ['array', 'life']);
});

test('handle normalization and validation', () => {
  equal(N.normalizeHandle('  @Tourist '), 'Tourist');
  assert(N.isValidHandle('tourist'));
  assert(N.isValidHandle('user.name_1'));
  assert(!N.isValidHandle('bad handle'));
  assert(!N.isValidHandle(''));
});

test('fuzzy similarity recognizes extra qualifiers and spelling forms', () => {
  const a = N.normalizeTitle('Array Cloning Technique (Easy Version)');
  const b = N.normalizeTitle('Array Cloning Technique');
  assert(N.nameSimilarity(a, b) > 0.88, 'extra qualifier score too low: ' + N.nameSimilarity(a, b));
  assert(N.nameSimilarity('watermelon', 'watermelons') > 0.9);
  assert(N.nameSimilarity('lakeside trail hard version', 'lakeside trail') > 0.85);
});

test('unrelated titles stay below the fuzzy threshold', () => {
  assert(N.nameSimilarity('game of life', 'game of stones') < 0.7);
  assert(N.nameSimilarity('array', 'array cloning technique') < 0.5);
});

section('Matching');
const CF_PROBLEMS = [
  { contestId: 4, index: 'A', name: 'Watermelon', rating: 800, tags: ['brute force', 'math'] },
  { contestId: 1, index: 'A', name: 'Theatre Square', rating: 1000, tags: ['math'] },
  {
    contestId: 1234,
    index: 'C',
    name: 'Array Cloning Technique',
    rating: 1400,
    tags: ['constructive algorithms', 'greedy'],
  },
  { contestId: 5678, index: 'A', name: 'Collecting Balls', rating: 1600, tags: ['dp'] },
  { contestId: 5679, index: 'B', name: 'Collecting Balls', rating: 2000, tags: ['graphs'] },
  {
    contestId: 9999,
    index: 'Z',
    name: 'Lakeside Trail (Hard Version)',
    rating: 2200,
    tags: ['trees'],
  },
  { contestId: 479, index: 'A', name: 'Expression', rating: 1000, tags: ['brute force'] },
  { contestId: 64, index: 'B', name: 'Expression', rating: 1500, tags: ['expression parsing'] },
  { contestId: 58, index: 'E', name: 'Expression', rating: 2400, tags: ['dp'] },
  { contestId: 359, index: 'A', name: 'Table', rating: 1000, tags: ['implementation'] },
  { contestId: 1965, index: 'F', name: 'Credit Card', rating: 1900, tags: ['dp'] },
];
const ATCODER_PROBLEMS = [
  { id: 'abc300_a', contestId: 'abc300', index: 'A', name: 'N-choice question', difficulty: 20 },
  { id: 'abc301_b', contestId: 'abc301', index: 'B', name: 'Collecting Balls', difficulty: 800 },
  { id: 'abc302_c', contestId: 'abc302', index: 'C', name: 'Collecting Balls', difficulty: 1000 },
  { id: 'abc303_d', contestId: 'abc303', index: 'D', name: 'Watermelon', difficulty: 100 },
  { id: 'abc304_e', contestId: 'abc304', index: 'E', name: 'A + B', difficulty: 50 },
];
const CATALOG = MATCHER.buildCatalog(CF_PROBLEMS, ATCODER_PROBLEMS);

test('builds both catalogs', () => {
  equal(CATALOG.sizes.codeforces, CF_PROBLEMS.length);
  equal(CATALOG.sizes.atcoder, ATCODER_PROBLEMS.length);
});

test('matches by official contest id regardless of title', () => {
  const result = MATCHER.matchProblem(
    { contestId: 4, index: 'A', name: 'Renamed Watermelon', rating: 800 },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'contest-id');
  equal(result.key, 'cf:4:A');
  equal(result.rating, 800);
});

test('matches exact title when the gym index changed', () => {
  const result = MATCHER.matchProblem(
    { contestId: 200000, index: 'B', name: 'A. Theatre Square' },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'exact-name');
  equal(result.key, 'cf:1:A');
  equal(result.isGym, true);
});

test('disambiguates duplicate CF titles by rating', () => {
  const result = MATCHER.matchProblem(
    { contestId: 300000, index: 'C', name: 'Collecting Balls', rating: 2000 },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'exact-name');
  equal(result.key, 'cf:5679:B');
});

test('mark unresolvable duplicate titles as ambiguous', () => {
  const result = MATCHER.matchProblem(
    { contestId: 300001, index: 'X', name: 'Collecting Balls' },
    CATALOG
  );
  equal(result.matched, false);
  equal(result.reason, 'ambiguous-cf-title');
});

test('fuzzy-matches a renamed qualifier variant', () => {
  const result = MATCHER.matchProblem(
    {
      contestId: 200001,
      index: 'D',
      name: 'Array Cloning Technique (Easy Version)',
      rating: 1400,
    },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'fuzzy-name');
  equal(result.key, 'cf:1234:C');
  assert(result.confidence >= 0.855);
});

test('builds an O(1) normalized-title Map', () => {
  assert(CATALOG.cf.exactNameMap instanceof Map);
  assert(CATALOG.cf.exactNameMap.has('watermelon'));
  equal(CATALOG.cf.exactNameMap.get('watermelon').length, 1);
  assert(CATALOG.cf.compactNameMap instanceof Map);
});

test('exact title is the primary key for a gym task without a valid official ID', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104123, index: 'Z', name: '  A. WATERMELON  ' },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'exact-name');
  equal(result.key, 'cf:4:A');
  equal(result.rating, 800);
  deepEqual(result.tags, ['brute force', 'math']);
});

test('matches a one-character typo with a high-confidence fallback', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104124, index: 'B', name: 'Watermellon' },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'fuzzy-name');
  equal(result.key, 'cf:4:A');
});

test('matches an extra qualifier only when the extra word is a known qualifier', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104125, index: 'C', name: 'Watermelon (Gym)' },
    CATALOG
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'fuzzy-name');
  equal(result.key, 'cf:4:A');
});

test('does not match a subset title with a meaningful extra word', () => {
  const tables = MATCHER.matchProblem(
    { contestId: 104126, index: 'D', name: 'Tables' },
    CATALOG
  );
  equal(tables.matched, false);

  const payment = MATCHER.matchProblem(
    { contestId: 104127, index: 'E', name: 'Credit Card Payment' },
    CATALOG
  );
  equal(payment.matched, false);
});

test('matches a Russian localized title from the same archive entry', () => {
  const localized = [
    { contestId: 4, index: 'A', name: 'Арбуз' },
    { contestId: 1, index: 'A', name: 'Театральная площадь' },
  ];
  const localizedCatalog = MATCHER.buildCatalog(CF_PROBLEMS, [], localized);
  const result = MATCHER.matchProblem(
    { contestId: 105000, index: 'C', name: 'A. Арбуз' },
    localizedCatalog
  );
  equal(result.source, 'codeforces');
  equal(result.strategy, 'exact-name');
  equal(result.key, 'cf:4:A');
  equal(result.rating, 800);
  deepEqual(result.tags, ['brute force', 'math']);
});

test('does not pick a duplicate title by index alone', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104128, index: 'B', name: 'Expression' },
    CATALOG
  );
  equal(result.matched, false);
  equal(result.reason, 'ambiguous-cf-title');
});

test('tags can support a fuzzy match but do not create one by themselves', () => {
  const supported = MATCHER.matchProblem(
    {
      contestId: 104129,
      index: 'F',
      name: 'Array Cloning Technique (Gym)',
      tags: ['constructive algorithms', 'greedy'],
    },
    CATALOG
  );
  equal(supported.source, 'codeforces');
  equal(supported.strategy, 'fuzzy-tags');

  const tagOnly = MATCHER.matchProblem(
    {
      contestId: 104130,
      index: 'G',
      name: 'Credit Card Payment',
      tags: ['dp'],
    },
    CATALOG
  );
  equal(tagOnly.matched, false);
});

test('respects fuzzyMatching=false', () => {
  const result = MATCHER.matchProblem(
    {
      contestId: 200001,
      index: 'D',
      name: 'Array Cloning Technique (Easy Version)',
      rating: 1400,
    },
    CATALOG,
    { fuzzyMatching: false }
  );
  equal(result.matched, false);
});

test('matches a unique gym title against AtCoder', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104000, index: 'B', name: 'N-choice question' },
    CATALOG
  );
  equal(result.source, 'atcoder');
  equal(result.strategy, 'atcoder-exact-name');
  equal(result.key, 'atcoder:abc300_a');
  equal(result.difficulty, 20);
});

test('does not use AtCoder for non-gym contests', () => {
  const result = MATCHER.matchProblem(
    { contestId: 2000, index: 'B', name: 'N-choice question' },
    CATALOG
  );
  equal(result.matched, false);
});

test('respects atcoderEnabled=false', () => {
  const result = MATCHER.matchProblem(
    { contestId: 104000, index: 'B', name: 'N-choice question' },
    CATALOG,
    { atcoderEnabled: false }
  );
  equal(result.matched, false);
});

test('skips ambiguous and generic AtCoder titles', () => {
  const ambiguous = MATCHER.matchProblem(
    { contestId: 104000, index: 'X', name: 'Collecting Balls' },
    CATALOG
  );
  equal(ambiguous.matched, false);
  assert(ambiguous.atcoderAmbiguous === true);

  const genericCatalog = MATCHER.buildCatalog([], [
    { id: 'x_a', contestId: 'x', index: 'A', name: 'Watermelon', difficulty: 10 },
  ]);
  const generic = MATCHER.matchProblem(
    { contestId: 104000, index: 'A', name: 'Watermelon' },
    genericCatalog
  );
  equal(generic.matched, false);
});

section('Statistics');
const SOLVED = [
  { c: 4, i: 'A', n: 'Watermelon', r: 800, t: ['brute force', 'math'], ts: 100 },
  { c: 104000, i: 'A', n: 'A. Watermelon', t: [], ts: 200 },
  { c: 104000, i: 'B', n: 'N-choice question', t: [], ts: 300 },
  { c: 104000, i: 'C', n: 'Unknown Task', t: ['greedy'], ts: 400 },
  { c: 200002, i: 'B', n: 'Collecting Balls', r: 1600, t: ['dp'], ts: 500 },
  {
    c: 200003,
    i: 'D',
    n: 'Array Cloning Technique (Easy Version)',
    r: 1400,
    t: ['greedy'],
    ts: 600,
  },
  { c: 3000, i: 'D', n: 'Mystery 3000', r: 3000, t: [], ts: 700 },
  { c: 3000, i: 'E', n: 'Mystery 3500', r: 3500, t: [], ts: 800 },
];

const STATS_DATA = STATS.buildStats({
  handle: 'tester',
  solved: SOLVED,
  catalog: CATALOG,
  totalSubmissions: 42,
  fetchedAt: 1700000000000,
  settings: { topTags: 12, recentLimit: 5 },
  meta: {
    cfArchive: { fetchedAt: 1700000000000, fromCache: true, stale: false },
    atcoderArchive: { fetchedAt: 1700000000000, fromCache: true, stale: false, enabled: true },
  },
});

test('deduplicates a gym problem and its official counterpart', () => {
  equal(STATS_DATA.totalSolved, 7);
  equal(STATS_DATA.rawSolved, 8);
  equal(STATS_DATA.diagnostics.duplicatesMerged, 1);
  equal(STATS_DATA.sourceCounts.codeforces, 3);
  equal(STATS_DATA.sourceCounts.atcoder, 1);
  equal(STATS_DATA.sourceCounts.other, 3);
});

test('computes training coverage', () => {
  equal(STATS_DATA.training.total, 5);
  equal(STATS_DATA.training.matched, 4);
  equal(STATS_DATA.training.codeforces, 3);
  equal(STATS_DATA.training.atcoder, 1);
  equal(STATS_DATA.training.unmatched, 1);
});

test('counts private-group tasks as training even without an official contest id', () => {
  const data = STATS.buildStats({
    handle: 'group_user',
    solved: [{
      g: 1,
      n: 'Внешняя задача',
      u: 'https://codeforces.com/group/abc/contest/12345/problem/A',
    }],
    catalog: MATCHER.buildCatalog([], []),
    totalSubmissions: 1,
    fetchedAt: 1700000000000,
    settings: { topTags: 12, recentLimit: 5 },
  });
  equal(data.totalSolved, 1);
  equal(data.training.total, 1);
  equal(data.training.unmatched, 1);
  equal(data.sourceCounts.other, 1);
});

test('builds CF rating buckets including 3000+', () => {
  equal(STATS_DATA.cfRating.rated, 5);
  equal(STATS_DATA.cfRating.unrated, 1);
  equal(STATS_DATA.cfRating.max, 3500);
  equal(STATS_DATA.cfRating.avg, 2060);
  const counts = Object.fromEntries(STATS_DATA.cfRating.buckets.map((b) => [b.label, b.count]));
  equal(counts['800'], 1);
  equal(counts['1400'], 1);
  equal(counts['1600'], 1);
  equal(counts['3000+'], 2);
  equal(counts['1000'], 0);
});

test('builds AtCoder difficulty buckets', () => {
  equal(STATS_DATA.atcoder.rated, 1);
  equal(STATS_DATA.atcoder.unrated, 0);
  equal(STATS_DATA.atcoder.buckets[0].count, 1);
  equal(STATS_DATA.atcoder.max, 20);
});

test('aggregates tags and counts untagged AtCoder tasks', () => {
  equal(STATS_DATA.tags.taggedProblems, 4);
  equal(STATS_DATA.tags.untaggedAtcoder, 1);
  const tags = Object.fromEntries(STATS_DATA.tags.items.map((item) => [item.tag, item.count]));
  equal(tags['greedy'], 2);
  equal(tags['math'], 1);
  equal(tags['dp'], 1);
  equal(tags['brute force'], 1);
});

test('recent training list contains only matched gym tasks, newest first', () => {
  equal(STATS_DATA.recent.length, 4);
  equal(STATS_DATA.recent[0].source, 'codeforces');
  equal(STATS_DATA.recent[0].name, 'Array Cloning Technique');
  equal(STATS_DATA.recent[1].name, 'Collecting Balls');
  equal(STATS_DATA.recent[2].source, 'atcoder');
  equal(STATS_DATA.recent[3].name, 'Watermelon');
  equal(STATS_DATA.recent[3].originalName, 'A. Watermelon');
});

test('match diagnostics are counted', () => {
  equal(STATS_DATA.diagnostics.strategies['contest-id'], 1);
  equal(STATS_DATA.diagnostics.strategies['exact-name'], 1);
  equal(STATS_DATA.diagnostics.strategies['fuzzy-name'], 1);
  equal(STATS_DATA.diagnostics.strategies['atcoder-exact-name'], 1);
  equal(STATS_DATA.diagnostics.strategies.none, 3);
});

test('topTags groups the tail into "other"', () => {
  const many = [];
  for (let i = 0; i < 9; i += 1) {
    many.push({ c: 5000 + i, i: 'A', n: 'Solved ' + i, r: 1000, t: ['tag' + i], ts: i });
  }
  const data = STATS.buildStats({
    handle: 'tags',
    solved: many,
    catalog: MATCHER.buildCatalog([], []),
    totalSubmissions: 9,
    fetchedAt: Date.now(),
    settings: { topTags: 5 },
  });
  equal(data.tags.items.length, 6);
  equal(data.tags.items[5].tag, 'other');
  equal(data.tags.items[5].count, 4);
});

test('empty input yields zeroed, render-safe stats', () => {
  const data = STATS.buildStats({
    handle: 'empty',
    solved: [],
    catalog: CATALOG,
    totalSubmissions: 0,
    fetchedAt: Date.now(),
    settings: {},
  });
  equal(data.totalSolved, 0);
  equal(data.cfRating.rated, 0);
  equal(data.cfRating.max, null);
  equal(data.tags.items.length, 0);
  equal(data.recent.length, 0);
  assert(data.percent.codeforces === 0);
});

section('API helpers');
test('trimSubmissions keeps only AC and the earliest one per problem', () => {
  const trimmed = API.trimSubmissions([
    {
      verdict: 'WRONG_ANSWER',
      creationTimeSeconds: 1,
      problem: { contestId: 4, index: 'A', name: 'Watermelon' },
    },
    {
      verdict: 'OK',
      creationTimeSeconds: 10,
      problem: { contestId: 4, index: 'A', name: 'Watermelon', rating: 800, tags: ['math'] },
      author: { participantType: 'PRACTICE' },
    },
    {
      verdict: 'OK',
      creationTimeSeconds: 5,
      problem: { contestId: 4, index: 'A', name: 'Watermelon', rating: 800, tags: ['math'] },
      author: { participantType: 'CONTESTANT' },
    },
    {
      verdict: 'OK',
      creationTimeSeconds: 7,
      problem: { contestId: 100000, index: 'B', name: 'Gym Task', tags: [] },
    },
  ]);
  equal(trimmed.totalSubmissions, 4);
  equal(trimmed.solved.length, 2);
  equal(trimmed.solved[0].ts, 5);
  equal(trimmed.solved[0].r, 800);
  equal(trimmed.solved[1].c, 100000);
});

test('compactCfProblems deduplicates and normalizes fields', () => {
  const compact = API.compactCfProblems([
    { contestId: 4, index: 'A', name: 'Watermelon', rating: 800, tags: ['math', null] },
    { contestId: 4, index: 'A', name: 'Duplicate', rating: 900, tags: [] },
    { contestId: 5, index: 'B', name: 'No rating', tags: [] },
    { contestId: null, index: 'X', name: 'Invalid' },
  ]);
  equal(compact.length, 2);
  equal(compact[0].name, 'Watermelon');
  equal(compact[0].rating, 800);
  equal(compact[1].rating, null);
});

test('compactAtCoderProblems merges difficulty models', () => {
  const compact = API.compactAtCoderProblems([
    { id: 'a', contest_id: 'c', problem_index: 'A', name: 'Alpha' },
    { id: 'b', contest_id: 'c', problem_index: 'B', name: 'Beta' },
    { id: 'a', contest_id: 'c', problem_index: 'A', name: 'Duplicate' },
  ], { a: { difficulty: 1234.6 }, b: { difficulty: null } });
  equal(compact.length, 2);
  equal(compact[0].difficulty, 1235);
  equal(compact[1].difficulty, null);
});

section('HTML scraper helpers');
test('accepts English and Russian accepted verdicts', () => {
  assert(SCRAPE.isAcceptedVerdict('Accepted'));
  assert(SCRAPE.isAcceptedVerdict('  Полное решение  '));
  assert(SCRAPE.isAcceptedVerdict('OK'));
  assert(!SCRAPE.isAcceptedVerdict('Wrong answer'));
  assert(!SCRAPE.isAcceptedVerdict('Неправильный ответ'));
});

test('cleans problem prefixes from submission links', () => {
  equal(SCRAPE.cleanProblemName('A - Арбуз'), 'Арбуз');
  equal(SCRAPE.cleanProblemName('B. Watermelon'), 'Watermelon');
  equal(SCRAPE.cleanProblemName('G2) Lakeside Trail'), 'Lakeside Trail');
});

test('handles official, gym and private-group problem URLs', () => {
  deepEqual(SCRAPE.parseProblemHref('/contest/4/problem/A'), {
    contestId: 4, index: 'A', url: 'https://codeforces.com/contest/4/problem/A', group: false,
  });
  deepEqual(SCRAPE.parseProblemHref('https://codeforces.com/gym/104000/problem/B'), {
    contestId: 104000, index: 'B', url: 'https://codeforces.com/gym/104000/problem/B', group: false,
  });
  deepEqual(SCRAPE.parseProblemHref('/group/abc/contest/12345/problem/C1'), {
    contestId: null, index: 'C1',
    url: 'https://codeforces.com/group/abc/contest/12345/problem/C1', group: true,
  });
  deepEqual(SCRAPE.parseProblemHref('/problemset/problem/1/A'), {
    contestId: 1, index: 'A', url: 'https://codeforces.com/problemset/problem/1/A', group: false,
  });
});

test('detects Cloudflare/security challenge pages', () => {
  assert(SCRAPE.looksLikeChallenge('<title>Just a moment...</title>'));
  assert(SCRAPE.looksLikeChallenge('Выполнение проверки безопасности'));
  assert(!SCRAPE.looksLikeChallenge('<table class="status-frame-datatable"></table>'));
});

section('Settings');
test('clamps unsafe settings', () => {
  const normalized = SETTINGS.normalizeSettings({
    minRequestDelayMs: 10,
    maxRetries: 100,
    archiveTtlHours: 0,
    statusTtlMinutes: 9999,
    atcoderEnabled: 'false',
    fuzzyMatching: 'true',
    topTags: 100,
    recentLimit: 1,
  });
  equal(normalized.minRequestDelayMs, 1000);
  equal(normalized.maxRetries, 8);
  equal(normalized.archiveTtlHours, 1);
  equal(normalized.statusTtlMinutes, 240);
  equal(normalized.atcoderEnabled, false);
  equal(normalized.fuzzyMatching, true);
  equal(normalized.topTags, 20);
  equal(normalized.recentLimit, 3);
});

test('uses safe defaults for garbage input', () => {
  deepEqual(SETTINGS.normalizeSettings(null), SETTINGS.normalizeSettings(SETTINGS.DEFAULTS));
  equal(SETTINGS.normalizeSettings({ minRequestDelayMs: 'abc' }).minRequestDelayMs, 2100);
});

test('clamps HTML scraping settings', () => {
  const normalized = SETTINGS.normalizeSettings({
    htmlScraping: 'false',
    maxScrapePages: 999,
    scrapeDelayMs: 10,
  });
  equal(normalized.htmlScraping, false);
  equal(normalized.maxScrapePages, 180);
  equal(normalized.scrapeDelayMs, 100);
});

if (failures.length) {
  console.error('\n' + failures.length + ' test(s) failed, ' + passed + ' passed.');
  process.exit(1);
} else {
  console.log('\nAll ' + passed + ' tests passed.');
}
