/**
 * Aggregates matched solved problems into chart-ready statistics.
 * Pure function — no browser APIs, fully unit-testable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./normalize.js'), require('./matcher.js'));
  } else {
    root.CFS_STATS = factory(root.CFS_CONST, root.CFS_NORMALIZE, root.CFS_MATCHER);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONST, NORMALIZE, MATCHER) {
  'use strict';

  const DEFAULT_TOP_TAGS = 12;
  const DEFAULT_RECENT = 5;

  function normalizeSolvedItem(item) {
    if (!item || typeof item !== 'object') return null;
    // Full Codeforces submission shape (tests / future use).
    if (item.problem && typeof item.problem === 'object') {
      const p = item.problem;
      return {
        contestId: p.contestId == null || p.contestId === '' ? null : Number(p.contestId),
        index: p.index == null ? '' : String(p.index),
        name: String(p.name == null ? '' : p.name),
        rating: p.rating == null || p.rating === '' || !Number.isFinite(Number(p.rating)) ||
          Number(p.rating) <= 0
          ? null
          : Number(p.rating),
        tags: Array.isArray(p.tags) ? p.tags.slice() : [],
        solvedAt: Number(item.creationTimeSeconds) || 0,
        participantType: item.author && item.author.participantType ? item.author.participantType : null,
        group: false,
        isGym: MATCHER.isGymContestId(Number(p.contestId)),
        url: null,
      };
    }
    // Compact cache shape.
    const contestId = item.c != null ? item.c : item.contestId;
    const index = item.i != null ? item.i : item.index;
    const name = item.n != null ? item.n : item.name;
    const rating = item.r != null ? item.r : item.rating;
    const tags = item.t != null ? item.t : item.tags;
    const group = item.g === 1 || item.g === true || item.group === true;
    return {
      contestId: contestId == null || contestId === '' ? null : Number(contestId),
      index: index == null ? '' : String(index),
      name: String(name == null ? '' : name),
      rating: rating == null || rating === '' || !Number.isFinite(Number(rating)) ||
        Number(rating) <= 0
        ? null
        : Number(rating),
      tags: Array.isArray(tags) ? tags.slice() : [],
      solvedAt: Number(item.ts != null ? item.ts : item.solvedAt) || 0,
      participantType: item.pt || null,
      group,
      isGym: group || (contestId != null && contestId !== '' && MATCHER.isGymContestId(Number(contestId))),
      url: item.u || item.url || null,
    };
  }

  function rawKey(item) {
    if (item.group && item.url) {
      return 'raw:group:' + item.url;
    }
    if (item.contestId != null && item.index) {
      return 'raw:' + item.contestId + ':' + item.index;
    }
    return 'raw:name:' + NORMALIZE.normalizeTitle(item.name);
  }

  function makeBuckets(definitions) {
    return definitions.map(function (definition) {
      return {
        label: definition.label,
        min: definition.min,
        max: definition.max,
        count: 0,
      };
    });
  }

  function putInBucket(buckets, value, clampLow) {
    if (value == null || !Number.isFinite(value)) return false;
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];
      if (value >= bucket.min && value <= bucket.max) {
        bucket.count += 1;
        return true;
      }
    }
    if (clampLow && value < buckets[0].min) {
      buckets[0].count += 1;
      return true;
    }
    if (value > buckets[buckets.length - 1].min && buckets[buckets.length - 1].max === Infinity) {
      buckets[buckets.length - 1].count += 1;
      return true;
    }
    return false;
  }

  function percent(part, total) {
    if (!total) return 0;
    return Math.round((part / total) * 1000) / 10;
  }

  function average(values) {
    if (!values.length) return null;
    let sum = 0;
    for (const value of values) sum += value;
    return Math.round(sum / values.length);
  }

  function dedupeSolved(solved, catalog, options) {
    const rawMap = new Map();
    for (const original of solved) {
      const item = normalizeSolvedItem(original);
      if (!item || !item.name) continue;
      const key = rawKey(item);
      const existing = rawMap.get(key);
      if (!existing) {
        rawMap.set(key, item);
      } else if (item.solvedAt && (!existing.solvedAt || item.solvedAt < existing.solvedAt)) {
        // Keep the first solve of the same raw problem.
        existing.solvedAt = item.solvedAt;
      }
    }

    const resolvedMap = new Map();
    let matchedCount = 0;
    let atcoderAmbiguous = 0;

    for (const item of rawMap.values()) {
      const resolved = MATCHER.matchProblem(item, catalog, {
        fuzzyMatching: options.fuzzyMatching !== false,
        atcoderEnabled: options.atcoderEnabled !== false,
      });
      if (resolved.matched) matchedCount += 1;
      if (resolved.atcoderAmbiguous) atcoderAmbiguous += 1;

      const existing = resolvedMap.get(resolved.key);
      if (!existing) {
        resolvedMap.set(resolved.key, Object.assign({}, resolved, {
          solvedAt: item.solvedAt,
          gymSolvedAt: item.isGym ? item.solvedAt : 0,
          gymOriginal: item.isGym ? resolved.original : null,
        }));
      } else {
        // Same original problem solved both officially and in a gym: keep one
        // entry, but remember the gym origin for the "from trainings" card.
        if (item.solvedAt && (!existing.solvedAt || item.solvedAt < existing.solvedAt)) {
          existing.solvedAt = item.solvedAt;
        }
        if (item.isGym) {
          existing.isGym = true;
          existing.gymOriginal = resolved.original;
          if (item.solvedAt && (!existing.gymSolvedAt || item.solvedAt < existing.gymSolvedAt)) {
            existing.gymSolvedAt = item.solvedAt;
          }
        }
      }
    }

    return {
      items: Array.from(resolvedMap.values()),
      rawUnique: rawMap.size,
      matchedCount,
      atcoderAmbiguous,
    };
  }

  function buildTags(items, topTagsLimit) {
    const counts = new Map();
    let taggedProblems = 0;
    let untaggedAtcoder = 0;

    for (const item of items) {
      if (item.source === 'atcoder') {
        if (!item.tags.length) untaggedAtcoder += 1;
        continue;
      }
      if (!item.tags.length) continue;
      taggedProblems += 1;
      for (const tag of item.tags) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }

    const sorted = Array.from(counts.entries()).sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });

    const limit = Math.max(5, Math.min(20, Number(topTagsLimit) || DEFAULT_TOP_TAGS));
    const visible = sorted.slice(0, limit);
    const restCount = sorted.slice(limit).reduce(function (sum, entry) {
      return sum + entry[1];
    }, 0);

    const tagItems = visible.map(function (entry) {
      return {
        tag: entry[0],
        count: entry[1],
        percent: percent(entry[1], taggedProblems),
      };
    });

    if (restCount > 0) {
      tagItems.push({
        tag: 'other',
        count: restCount,
        percent: percent(restCount, taggedProblems),
        isOther: true,
      });
    }

    return {
      items: tagItems,
      distinctTags: sorted.length,
      taggedProblems,
      untaggedAtcoder,
      totalOccurrences: sorted.reduce(function (sum, entry) { return sum + entry[1]; }, 0),
    };
  }

  function pickRecentTraining(items, limit) {
    return items
      .filter(function (item) {
        return item.isGym && item.source !== 'other' && item.gymOriginal;
      })
      .sort(function (a, b) { return (b.gymSolvedAt || 0) - (a.gymSolvedAt || 0); })
      .slice(0, Math.max(3, Math.min(10, Number(limit) || DEFAULT_RECENT)))
      .map(function (item) {
        return {
          name: item.name,
          source: item.source,
          strategy: item.strategy,
          confidence: item.confidence,
          rating: item.rating,
          difficulty: item.difficulty,
          url: item.url,
          originalName: item.gymOriginal.name,
          originalUrl: item.gymOriginal.url,
          solvedAt: item.gymSolvedAt || item.solvedAt,
        };
      });
  }

  /**
   * @param {object} input
   * @param {string} input.handle
   * @param {Array} input.solved compact or full submissions
   * @param {object} input.catalog result of CFS_MATCHER.buildCatalog()
   * @param {number} input.totalSubmissions
   * @param {number} input.fetchedAt status cache timestamp (ms)
   * @param {object} input.meta archive cache metadata
   * @param {object} input.settings normalized settings
   * @returns {object} chart-ready statistics
   */
  function buildStats(input) {
    const data = input || {};
    const options = data.settings || {};
    const solved = Array.isArray(data.solved) ? data.solved : [];
    const catalog = data.catalog || MATCHER.buildCatalog([], []);
    const deduped = dedupeSolved(solved, catalog, options);
    const items = deduped.items;

    const cfRatingBuckets = makeBuckets(CONST.CF_RATING_BUCKETS);
    const atcoderBuckets = makeBuckets(CONST.ATCODER_BUCKETS);
    const cfRatings = [];
    const atcoderDifficulties = [];
    const strategies = {
      'contest-id': 0,
      'exact-name': 0,
      'fuzzy-name': 0,
      'fuzzy-tags': 0,
      'atcoder-exact-name': 0,
      none: 0,
    };
    const sourceCounts = { codeforces: 0, atcoder: 0, other: 0 };
    const training = {
      total: 0,
      matched: 0,
      codeforces: 0,
      atcoder: 0,
      unmatched: 0,
    };
    const unmatchedExamples = [];

    for (const item of items) {
      sourceCounts[item.source] = (sourceCounts[item.source] || 0) + 1;
      strategies[item.strategy] = (strategies[item.strategy] || 0) + 1;

      if (item.isGym) {
        training.total += 1;
        if (item.source === 'codeforces') {
          training.matched += 1;
          training.codeforces += 1;
        } else if (item.source === 'atcoder') {
          training.matched += 1;
          training.atcoder += 1;
        } else {
          training.unmatched += 1;
          if (unmatchedExamples.length < 20) {
            unmatchedExamples.push({
              name: item.name,
              url: item.url,
              contestId: item.contestId,
              index: item.index,
              reason: item.reason || 'no-match',
            });
          }
        }
      }

      if (item.source === 'atcoder') {
        if (item.difficulty != null) {
          atcoderDifficulties.push(item.difficulty);
          putInBucket(atcoderBuckets, item.difficulty, true);
        }
      } else if (item.rating != null) {
        cfRatings.push(item.rating);
        putInBucket(cfRatingBuckets, item.rating, true);
      }
    }

    const tags = buildTags(items, options.topTags);
    const totalSolved = items.length;

    return {
      handle: data.handle || '',
      generatedAt: Date.now(),
      fetchedAt: data.fetchedAt || 0,
      totalSubmissions: Number(data.totalSubmissions) || 0,
      totalSolved,
      rawSolved: deduped.rawUnique,
      sourceCounts,
      training,
      cfRating: {
        buckets: cfRatingBuckets,
        rated: cfRatings.length,
        unrated: sourceCounts.codeforces + sourceCounts.other - cfRatings.length,
        max: cfRatings.length ? Math.max.apply(null, cfRatings) : null,
        avg: average(cfRatings),
        percentOfAll: percent(cfRatings.length, totalSolved),
      },
      atcoder: {
        buckets: atcoderBuckets,
        rated: atcoderDifficulties.length,
        unrated: sourceCounts.atcoder - atcoderDifficulties.length,
        max: atcoderDifficulties.length ? Math.max.apply(null, atcoderDifficulties) : null,
        avg: average(atcoderDifficulties),
        percentOfAll: percent(atcoderDifficulties.length, totalSolved),
      },
      tags,
      recent: pickRecentTraining(items, options.recentLimit),
      diagnostics: {
        strategies,
        atcoderAmbiguous: deduped.atcoderAmbiguous,
        unmatchedExamples,
        duplicatesMerged: deduped.rawUnique - totalSolved,
      },
      archives: {
        codeforces: {
          count: catalog.sizes ? catalog.sizes.codeforces : 0,
          fetchedAt: data.meta && data.meta.cfArchive ? data.meta.cfArchive.fetchedAt : 0,
          stale: !!(data.meta && data.meta.cfArchive && data.meta.cfArchive.stale),
          fromCache: !!(data.meta && data.meta.cfArchive && data.meta.cfArchive.fromCache),
        },
        atcoder: {
          count: catalog.sizes ? catalog.sizes.atcoder : 0,
          fetchedAt: data.meta && data.meta.atcoderArchive ? data.meta.atcoderArchive.fetchedAt : 0,
          stale: !!(data.meta && data.meta.atcoderArchive && data.meta.atcoderArchive.stale),
          fromCache: !!(data.meta && data.meta.atcoderArchive && data.meta.atcoderArchive.fromCache),
          enabled: !!(data.meta && data.meta.atcoderArchive && data.meta.atcoderArchive.enabled),
          error: data.meta && data.meta.atcoderArchive ? data.meta.atcoderArchive.error || null : null,
        },
      },
      warnings: Array.isArray(data.warnings) ? data.warnings.slice() : [],
      percent: {
        codeforces: percent(sourceCounts.codeforces, totalSolved),
        atcoder: percent(sourceCounts.atcoder, totalSolved),
        other: percent(sourceCounts.other, totalSolved),
      },
    };
  }

  return {
    buildStats,
    // Exposed for tests.
    _normalizeSolvedItem: normalizeSolvedItem,
    _dedupeSolved: dedupeSolved,
  };
});
