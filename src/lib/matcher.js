/**
 * Dual-catalog problem matcher.
 *
 * A solved Codeforces problem is resolved against:
 *   1. the official Codeforces problemset archive by normalized exact title
 *      (O(1) Map lookup), then by official contest ID;
 *   2. the AtCoder Problems archive for gym/training tasks that mirror AtCoder.
 *
 * Matching is conservative: a wrong match is worse than a missed one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize.js'));
  } else {
    root.CFS_MATCHER = factory(root.CFS_NORMALIZE);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (NORMALIZE) {
  'use strict';

  const FUZZY_THRESHOLD = 0.855;
  const FUZZY_MIN_MARGIN = 0.02;
  const FUZZY_MAX_CANDIDATES = 300;
  const MIN_FUZZY_LEXICAL = 0.70;
  const QUALIFIER_TOKENS = new Set([
    'easy', 'hard', 'version', 'versions', 'gym', 'problem', 'task',
    'edition', 'remake', 'extended', 'bonus',
  ]);

  // Very common AtCoder titles. Cross-judge exact matching is skipped for them
  // even if they happen to be unique in the current archive.
  const GENERIC_ATCODER_TITLES = new Set([
    'a b', 'a plus b', 'hello world', 'sum', 'maximum', 'minimum', 'game',
    'gcd', 'lcm', 'prime', 'palindrome', 'string', 'array', 'grid', 'test',
    'easy', 'hard', 'watermelon', 'sum of two numbers', 'two sum',
  ]);

  function isGymContestId(contestId) {
    return Number.isFinite(contestId) && contestId >= 100000;
  }

  function asNumberOrNull(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cleanTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const result = [];
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const trimmed = tag.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  }

  function normalizeRawProblem(problem) {
    const source = problem || {};
    const name = String(source.name == null ? '' : source.name).trim();
    const index = String(source.index == null ? '' : source.index).trim();
    const rawContestId = asNumberOrNull(source.contestId);
    const contestId = rawContestId != null && rawContestId > 0 ? rawContestId : null;
    const rawRating = asNumberOrNull(source.rating);
    const rating = rawRating != null && rawRating > 0 ? rawRating : null;
    const tags = cleanTags(source.tags);
    const normName = NORMALIZE.normalizeTitle(name);
    return {
      contestId,
      index,
      name,
      rating,
      tags,
      normName,
      looseName: NORMALIZE.normalizeLoose(name),
      compactName: NORMALIZE.normalizeCompact(normName),
      tokens: NORMALIZE.tokenize(normName),
      isGym: isGymContestId(contestId),
    };
  }

  function cfUrl(contestId, index) {
    if (!Number.isFinite(contestId) || !index) return null;
    if (isGymContestId(contestId)) {
      return 'https://codeforces.com/gym/' + contestId + '/problem/' + encodeURIComponent(index);
    }
    return 'https://codeforces.com/problemset/problem/' + contestId + '/' + encodeURIComponent(index);
  }

  function makeCfEntry(problem) {
    const contestId = asNumberOrNull(problem.contestId);
    const index = String(problem.index == null ? '' : problem.index).trim();
    const name = String(problem.name == null ? '' : problem.name).trim();
    const normName = NORMALIZE.normalizeTitle(name);
    if (!Number.isFinite(contestId) || !index || !name || !normName) return null;
    return {
      source: 'codeforces',
      key: 'cf:' + contestId + ':' + index,
      contestId,
      index,
      name,
      normName,
      looseName: NORMALIZE.normalizeLoose(name),
      compactName: NORMALIZE.normalizeCompact(normName),
      tokens: NORMALIZE.tokenize(normName),
      rating: asNumberOrNull(problem.rating),
      difficulty: null,
      tags: cleanTags(problem.tags),
      aliases: [],
      url: cfUrl(contestId, index),
    };
  }

  function makeAtCoderEntry(problem) {
    const id = String(problem.id == null ? '' : problem.id).trim();
    const contestId = String(problem.contestId == null ? '' : problem.contestId).trim();
    const index = String(problem.index == null ? '' : problem.index).trim();
    const name = String(problem.name == null ? '' : problem.name).trim();
    const normName = NORMALIZE.normalizeTitle(name);
    if (!id || !contestId || !name || !normName) return null;
    return {
      source: 'atcoder',
      key: 'atcoder:' + id,
      contestId,
      index,
      id,
      name,
      normName,
      looseName: NORMALIZE.normalizeLoose(name),
      compactName: NORMALIZE.normalizeCompact(normName),
      tokens: NORMALIZE.tokenize(normName),
      rating: null,
      difficulty: asNumberOrNull(problem.difficulty),
      tags: [],
      url: 'https://atcoder.jp/contests/' + encodeURIComponent(contestId) +
        '/tasks/' + encodeURIComponent(id),
    };
  }

  function addToPositionMap(map, key, position) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(position);
  }

  function addToEntryMap(map, key, entry) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.some(function (item) { return item.key === entry.key; })) {
      list.push(entry);
    }
  }

  /**
   * Builds all lookup indexes once per archive version.
   *
   * The important one is exactNameMap: it is a real Map keyed by the normalized
   * title, so matching a solved problem is O(1) instead of scanning 10k+ tasks.
   * compactNameMap/looseNameMap are cheap extra keys for punctuation/case
   * differences. byToken/byPrefix/byTag are only used by the high-confidence
   * fuzzy fallback.
   */
  function buildIndex(entries, source) {
    const byId = new Map();
    const exactNameMap = new Map();
    const looseNameMap = new Map();
    const compactNameMap = new Map();
    const byToken = new Map();
    const byPrefix = new Map();
    const byTag = new Map();
    const byRating = new Map();

    entries.forEach(function (entry, position) {
      if (source === 'codeforces') {
        byId.set(entry.contestId + ':' + entry.index, entry);
        if (entry.rating != null) {
          const bucket = Math.floor(entry.rating / 100);
          addToPositionMap(byRating, bucket, position);
        }
      } else {
        byId.set(entry.id, entry);
      }

      addToEntryMap(exactNameMap, entry.normName, entry);
      if (entry.looseName && entry.looseName !== entry.normName) {
        addToEntryMap(looseNameMap, entry.looseName, entry);
      }
      if (entry.compactName && entry.compactName.length >= 6) {
        addToEntryMap(compactNameMap, entry.compactName, entry);
      }
      for (const alias of entry.aliases || []) {
        const aliasNorm = NORMALIZE.normalizeTitle(alias);
        const aliasLoose = NORMALIZE.normalizeLoose(alias);
        const aliasCompact = NORMALIZE.normalizeCompact(aliasNorm);
        if (aliasNorm && aliasNorm !== entry.normName) {
          addToEntryMap(exactNameMap, aliasNorm, entry);
        }
        if (aliasLoose && aliasLoose !== entry.looseName) {
          addToEntryMap(looseNameMap, aliasLoose, entry);
        }
        if (aliasCompact && aliasCompact.length >= 6 && aliasCompact !== entry.compactName) {
          addToEntryMap(compactNameMap, aliasCompact, entry);
        }
      }
      if (entry.compactName && entry.compactName.length >= 5) {
        addToPositionMap(byPrefix, entry.compactName.slice(0, 4), position);
      }
      for (const token of entry.tokens) {
        if (token.length >= 3) addToPositionMap(byToken, token, position);
      }
      if (source === 'codeforces') {
        for (const tag of entry.tags) {
          addToPositionMap(byTag, tag.toLowerCase(), position);
        }
      }
    });

    return {
      source,
      entries,
      byId,
      exactNameMap,
      looseNameMap,
      compactNameMap,
      byToken,
      byPrefix,
      byTag,
      byRating,
      // Backwards-compatible alias for callers/tests that used byName.
      byName: exactNameMap,
      size: entries.length,
    };
  }

  /**
   * Builds the searchable catalog. Inputs are compact archive records:
   *   CF:      { contestId, index, name, rating, tags }
   *   AtCoder: { id, contestId, index, name, difficulty }
   *   cfAliases: [{ contestId, index, name }] — localized titles from the RU
   *              problemset archive, attached to the same CF entry.
   */
  function buildCatalog(cfProblems, atcoderProblems, cfAliases) {
    const cfEntries = [];
    const cfSeen = new Set();
    const cfByKey = new Map();
    for (const problem of Array.isArray(cfProblems) ? cfProblems : []) {
      const entry = makeCfEntry(problem);
      if (!entry || cfSeen.has(entry.key)) continue;
      cfSeen.add(entry.key);
      cfEntries.push(entry);
      cfByKey.set(entry.contestId + ':' + entry.index, entry);
    }

    for (const alias of Array.isArray(cfAliases) ? cfAliases : []) {
      const contestId = asNumberOrNull(alias && alias.contestId);
      const index = String(alias && alias.index != null ? alias.index : '').trim();
      const name = String(alias && alias.name != null ? alias.name : '').trim();
      if (!Number.isFinite(contestId) || !index || !name) continue;
      const entry = cfByKey.get(contestId + ':' + index);
      if (!entry || entry.name === name) continue;
      if (!entry.aliases.includes(name)) entry.aliases.push(name);
    }

    const atcoderEntries = [];
    const atcoderSeen = new Set();
    for (const problem of Array.isArray(atcoderProblems) ? atcoderProblems : []) {
      const entry = makeAtCoderEntry(problem);
      if (!entry || atcoderSeen.has(entry.key)) continue;
      atcoderSeen.add(entry.key);
      atcoderEntries.push(entry);
    }

    return {
      cf: buildIndex(cfEntries, 'codeforces'),
      atcoder: buildIndex(atcoderEntries, 'atcoder'),
      sizes: { codeforces: cfEntries.length, atcoder: atcoderEntries.length },
      localizedAliases: cfAliases ? cfAliases.length : 0,
    };
  }

  function tagOverlap(left, right) {
    if (!left.length || !right.length) return 0;
    const rightSet = new Set(right);
    let count = 0;
    for (const tag of left) {
      if (rightSet.has(tag)) count += 1;
    }
    return count;
  }

  function scoreDuplicateCandidate(entry, raw) {
    let score = 0;
    if (raw.rating != null && entry.rating != null) {
      const diff = Math.abs(raw.rating - entry.rating);
      if (diff === 0) score += 4;
      else if (diff <= 100) score += 2.5;
      else if (diff <= 200) score += 1;
      else if (diff > 400) score -= 3;
    }
    if (raw.contestId != null && entry.contestId === raw.contestId) score += 3;
    if (raw.index && entry.index === raw.index) score += 0.5;
    score += Math.min(4, tagOverlap(raw.tags, entry.tags) * 0.75);
    return score;
  }

  /**
   * Resolves duplicate titles in the CF archive using official contestId,
   * rating, index and tags. Index alone is not enough. Returns null when there
   * is no defensible winner.
   */
  function resolveExactCf(entries, raw) {
    if (entries.length === 1) {
      return { entry: entries[0], confidence: 0.98 };
    }
    const ranked = entries
      .map(function (entry) {
        return { entry, score: scoreDuplicateCandidate(entry, raw) };
      })
      .sort(function (a, b) { return b.score - a.score; });

    if (ranked.length < 2) {
      return { entry: ranked[0].entry, confidence: 0.9 };
    }
    // Index equality alone is not enough to pick one of several same-named
    // tasks: gym indices are frequently renumbered. Require a strong signal
    // (rating, official contestId or at least two overlapping tags).
    if (
      ranked[0].score >= 1.5 &&
      ranked[0].score > ranked[1].score + 0.2
    ) {
      return { entry: ranked[0].entry, confidence: 0.9 };
    }
    return null;
  }

  /**
   * O(1) exact-title lookup.
   *
   * Canonical normalized title is tried first; loose lower/trim and compact
   * (no punctuation/spaces) keys are only fallbacks for representation
   * differences. A duplicated title is resolved by rating/tags/official ID and
   * otherwise reported as ambiguous.
   */
  function findExactCf(catalog, raw) {
    if (!catalog || !raw) return null;
    const lookups = [
      { map: catalog.exactNameMap, key: raw.normName, minLength: 1 },
      { map: catalog.looseNameMap, key: raw.looseName, minLength: 1 },
      { map: catalog.compactNameMap, key: raw.compactName, minLength: 6 },
    ];
    let sawAmbiguous = false;
    for (const lookup of lookups) {
      if (!lookup.key || lookup.key.length < lookup.minLength) continue;
      const entries = lookup.map.get(lookup.key);
      if (!entries || !entries.length) continue;
      const resolved = resolveExactCf(entries, raw);
      if (resolved) {
        return {
          entry: resolved.entry,
          confidence: resolved.confidence,
          keyLength: lookup.key.length,
        };
      }
      sawAmbiguous = true;
    }
    return sawAmbiguous ? { ambiguous: true } : null;
  }

  function canMatchAtCoderExact(raw) {
    if (!raw.isGym) return false;
    if (!raw.normName || raw.normName.length < 9) return false;
    if (!raw.tokens.length) return false;
    if (GENERIC_ATCODER_TITLES.has(raw.normName)) return false;
    // A single short word is too ambiguous across judges.
    if (raw.tokens.length === 1 && raw.normName.length < 12) return false;
    return true;
  }

  function tokenAlignment(shorterTokens, longerTokens) {
    const used = new Set();
    let exactTokens = 0;
    let fuzzyTokens = 0;
    const singleToken = shorterTokens.length === 1;
    for (const token of shorterTokens) {
      const exactIndex = longerTokens.findIndex(function (candidate, index) {
        return !used.has(index) && candidate === token;
      });
      if (exactIndex >= 0) {
        used.add(exactIndex);
        exactTokens += 1;
        continue;
      }
      let bestIndex = -1;
      let bestScore = 0;
      for (let index = 0; index < longerTokens.length; index += 1) {
        if (used.has(index)) continue;
        const score = NORMALIZE.diceBigrams(token, longerTokens[index]);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex < 0 || bestScore < (singleToken ? 0.90 : 0.82)) return null;
      used.add(bestIndex);
      fuzzyTokens += 1;
    }
    for (let index = 0; index < longerTokens.length; index += 1) {
      if (!used.has(index) && !QUALIFIER_TOKENS.has(longerTokens[index])) return null;
    }
    return { exactTokens, fuzzyTokens };
  }

  /**
   * Fuzzy fallback is intentionally conservative:
   *  - every significant word of the shorter title must align with a word of
   *    the longer title;
   *  - unmatched words in the longer title may only be known qualifiers
   *    ("easy", "hard", "version", "gym", ...);
   *  - one-word titles additionally need a near-identical compact spelling.
   * This avoids matching "Credit Card Payment" to "Credit Card" or "Tables"
   * to "Table" just because they share a token.
   */
  function fuzzyEvidence(raw, entry) {
    const rawTokens = raw.tokens;
    const entryTokens = entry.tokens;
    if (!rawTokens.length || !entryTokens.length) return false;
    const shorter = rawTokens.length <= entryTokens.length ? rawTokens : entryTokens;
    const longer = rawTokens.length <= entryTokens.length ? entryTokens : rawTokens;
    const alignment = tokenAlignment(shorter, longer);
    if (!alignment) return false;

    if (Math.min(rawTokens.length, entryTokens.length) === 1 && alignment.fuzzyTokens > 0) {
      const lev = NORMALIZE.levenshteinRatio(raw.compactName, entry.compactName);
      if (lev < 0.90) return false;
    }
    return true;
  }

  function collectFuzzyCandidates(raw, catalog) {
    const candidates = new Map();
    function add(position, weight) {
      candidates.set(position, (candidates.get(position) || 0) + weight);
    }

    for (const token of raw.tokens) {
      if (token.length < 3) continue;
      const positions = catalog.byToken.get(token);
      if (!positions) continue;
      for (const position of positions) add(position, 1);
    }

    for (const tag of raw.tags) {
      const positions = catalog.byTag.get(String(tag).toLowerCase());
      if (!positions) continue;
      for (const position of positions) add(position, 0.7);
    }

    if (raw.compactName.length >= 8) {
      const prefix = raw.compactName.slice(0, 4);
      const positions = catalog.byPrefix.get(prefix);
      if (positions) {
        for (const position of positions) add(position, 0.25);
      }
    }

    if (raw.rating != null && candidates.size < 30) {
      const bucket = Math.floor(raw.rating / 100);
      const positions = catalog.byRating.get(bucket);
      if (positions) {
        for (const position of positions) add(position, 0.2);
      }
    }

    return Array.from(candidates.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, FUZZY_MAX_CANDIDATES);
  }

  function fuzzyCf(raw, catalog) {
    if (!raw.normName || raw.normName.length < 8) return null;

    const rankedPositions = collectFuzzyCandidates(raw, catalog);
    if (!rankedPositions.length) return null;

    const scored = [];
    for (const [position] of rankedPositions) {
      const entry = catalog.entries[position];
      if (!entry) continue;

      const lexical = Math.max(
        NORMALIZE.nameSimilarity(raw.normName, entry.normName, raw.tokens, entry.tokens),
        NORMALIZE.levenshteinRatio(raw.compactName, entry.compactName) * 0.96
      );
      if (lexical < MIN_FUZZY_LEXICAL) continue;

      const overlap = tagOverlap(raw.tags, entry.tags);
      const union = new Set(raw.tags.concat(entry.tags)).size;
      const tagJaccard = union ? overlap / union : 0;
      if (!fuzzyEvidence(raw, entry)) continue;

      let score = lexical;
      let tagAssisted = false;
      if (overlap >= 2 && tagJaccard >= 0.5) {
        score += 0.02 + 0.03 * tagJaccard;
        tagAssisted = true;
      }
      if (raw.rating != null && entry.rating != null) {
        const diff = Math.abs(raw.rating - entry.rating);
        if (diff === 0) score += 0.012;
        else if (diff > 400) score -= 0.12;
        else if (diff > 300) score -= 0.06;
      }

      if (score >= FUZZY_THRESHOLD) {
        scored.push({ entry, score, tagAssisted });
      }
    }

    if (!scored.length) return null;
    scored.sort(function (a, b) { return b.score - a.score; });

    const best = scored[0];
    const second = scored[1];
    if (second && best.score - second.score < FUZZY_MIN_MARGIN) {
      return { ambiguous: true };
    }
    return {
      entry: best.entry,
      confidence: Math.min(0.97, best.score),
      tagAssisted: best.tagAssisted,
    };
  }

  function matchedResult(entry, raw, strategy, confidence) {
    return {
      matched: true,
      source: entry.source,
      key: entry.key,
      strategy,
      confidence,
      name: entry.name,
      contestId: entry.contestId,
      index: entry.index,
      rating: entry.source === 'codeforces' ? entry.rating : null,
      difficulty: entry.source === 'atcoder' ? entry.difficulty : null,
      tags: entry.source === 'codeforces' ? entry.tags.slice() : [],
      url: entry.url,
      isGym: raw.isGym,
      original: {
        contestId: raw.contestId,
        index: raw.index,
        name: raw.name,
        rating: raw.rating,
        tags: raw.tags.slice(),
        url: cfUrl(raw.contestId, raw.index),
      },
    };
  }

  function unmatchedResult(raw, reason, extra) {
    const keyNormalized = raw.normName || raw.name.toLowerCase();
    return Object.assign({
      matched: false,
      source: 'other',
      key: 'other:' + keyNormalized + ':' + (raw.rating == null ? '?' : raw.rating),
      strategy: 'none',
      confidence: 0,
      name: raw.name,
      contestId: raw.contestId,
      index: raw.index,
      rating: raw.rating,
      difficulty: null,
      tags: raw.tags.slice(),
      url: cfUrl(raw.contestId, raw.index),
      isGym: raw.isGym,
      reason: reason || 'no-match',
      atcoderAmbiguous: false,
      original: {
        contestId: raw.contestId,
        index: raw.index,
        name: raw.name,
        rating: raw.rating,
        tags: raw.tags.slice(),
        url: cfUrl(raw.contestId, raw.index),
      },
    }, extra || {});
  }

  /**
   * Matches one solved problem. Returns a resolved object; never throws for
   * malformed input.
   */
  function matchProblem(problem, catalog, options) {
    const opts = options || {};
    const raw = normalizeRawProblem(problem);
    if (!raw.name) return unmatchedResult(raw, 'missing-name');

    const cfArchive = catalog && catalog.cf;
    const atcoderArchive = catalog && catalog.atcoder;
    if (!cfArchive) return unmatchedResult(raw, 'catalog-empty');

    let exactReason = null;
    let atcoderAmbiguous = false;

    const direct = raw.contestId != null && raw.index
      ? cfArchive.byId.get(raw.contestId + ':' + raw.index)
      : null;

    // 1. Exact title is the primary lookup (O(1) Map hit). This is what makes
    // a gym task with a renumbered index or missing original contestId work.
    const exact = findExactCf(cfArchive, raw);
    if (exact && exact.entry) {
      if (!direct) {
        return matchedResult(exact.entry, raw, 'exact-name', exact.confidence);
      }
      if (direct.key === exact.entry.key) {
        // Same problem resolved by both keys; report the authoritative ID.
        return matchedResult(direct, raw, 'contest-id', 1);
      }
      // An official submission can carry an authoritative contestId that
      // conflicts with a title collision; in that case the ID wins.
      return matchedResult(direct, raw, 'contest-id', 1);
    }
    if (exact && exact.ambiguous) exactReason = 'ambiguous-cf-title';

    // 2. Exact official contestId fallback for a renamed archive title, or for
    // an ambiguous name that becomes unambiguous by ID.
    if (direct) return matchedResult(direct, raw, 'contest-id', 1);

    // 3. Exact AtCoder title for gym tasks remains a cross-judge fallback.
    if (opts.atcoderEnabled !== false && atcoderArchive && canMatchAtCoderExact(raw)) {
      const atcoderEntries = atcoderArchive.exactNameMap.get(raw.normName);
      if (atcoderEntries && atcoderEntries.length === 1) {
        return matchedResult(
          atcoderEntries[0],
          raw,
          'atcoder-exact-name',
          0.86
        );
      }
      if (atcoderEntries && atcoderEntries.length > 1) {
        atcoderAmbiguous = true;
      }
    }

    // 4. High-confidence fuzzy fallback against the CF archive.
    if (opts.fuzzyMatching !== false) {
      const fuzzy = fuzzyCf(raw, cfArchive);
      if (fuzzy && fuzzy.entry) {
        return matchedResult(
          fuzzy.entry,
          raw,
          fuzzy.tagAssisted ? 'fuzzy-tags' : 'fuzzy-name',
          fuzzy.confidence
        );
      }
      if (fuzzy && fuzzy.ambiguous && !exactReason) {
        exactReason = 'ambiguous-fuzzy-match';
      }
    }

    return unmatchedResult(raw, exactReason || 'no-match', {
      atcoderAmbiguous,
    });
  }

  function matchProblems(problems, catalog, options) {
    return (Array.isArray(problems) ? problems : []).map(function (problem) {
      return matchProblem(problem, catalog, options);
    });
  }

  return {
    FUZZY_THRESHOLD,
    buildCatalog,
    matchProblem,
    matchProblems,
    isGymContestId,
    cfUrl,
    canMatchAtCoderExact,
    // Exposed for tests.
    _normalizeRawProblem: normalizeRawProblem,
    _fuzzyCf: fuzzyCf,
  };
});
