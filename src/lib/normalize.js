/**
 * Title normalization and fuzzy similarity helpers.
 * No network/browser APIs — safe to unit-test in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CFS_NORMALIZE = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'with',
    'at', 'by', 'from', 'into', 'over', 'under', 'is', 'are', 'be', 'as',
    'it', 'its', 'this', 'that', 'these', 'those', 'problem', 'problems',
    'task', 'tasks', 'contest', 'round', 'задача', 'задачи', 'и', 'в', 'на',
    'с', 'по', 'для', 'из', 'от', 'до', 'не', 'что', 'как', 'это',
  ]);

  /**
   * Removes a leading problem index such as "A. ", "G2) " or "Problem B — ".
   * Deliberately does NOT touch titles like "A + B" (no punctuation after A).
   */
  function stripIndexPrefix(value) {
    let text = String(value == null ? '' : value).trim();
    text = text.replace(
      /^(?:problem|task|задача)\s+[a-z]\d{0,2}\s*[.):\-–—]\s+/i,
      ''
    );
    text = text.replace(/^[a-z]\d{0,2}\s*[.):\-–—]\s+/i, '');
    return text;
  }

  /**
   * Canonical form used for exact matching and fuzzy scoring.
   * Example: "A. Watermelon" -> "watermelon".
   */
  function normalizeTitle(value) {
    let text = stripIndexPrefix(value);
    text = text.normalize('NFKC').toLowerCase();
    // Remove diacritics (é -> e) without breaking non-Latin scripts.
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    text = text.replace(/&/g, ' and ');
    // Apostrophes are removed (DEGwer's -> degwers), other punctuation becomes space.
    text = text.replace(/['’‘`´]/g, '');
    text = text.replace(/[^\p{L}\p{N}]+/gu, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  function tokenize(normalized) {
    if (!normalized) return [];
    const seen = new Set();
    const tokens = [];
    for (const token of normalized.split(' ')) {
      if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens;
  }

  /** Lowercase + trim variant, kept as an additional exact-key fallback. */
  function normalizeLoose(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** All spaces and punctuation removed; catches punctuation-only differences. */
  function normalizeCompact(normalized) {
    return String(normalized == null ? '' : normalized).replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function characterBigrams(normalized) {
    const chars = Array.from(String(normalized).replace(/\s+/g, ''));
    const grams = [];
    for (let i = 0; i < chars.length - 1; i += 1) {
      grams.push(chars[i] + chars[i + 1]);
    }
    return grams;
  }

  /** Sørensen–Dice coefficient over character bigram multisets. */
  function diceBigrams(left, right) {
    if (left === right) return left ? 1 : 0;
    if (!left || !right) return 0;
    const a = characterBigrams(left);
    const b = characterBigrams(right);
    if (!a.length || !b.length) return 0;
    const counts = new Map();
    for (const gram of a) counts.set(gram, (counts.get(gram) || 0) + 1);
    let overlap = 0;
    for (const gram of b) {
      const count = counts.get(gram) || 0;
      if (count > 0) {
        overlap += 1;
        counts.set(gram, count - 1);
      }
    }
    return (2 * overlap) / (a.length + b.length);
  }

  /** Dice coefficient over unique word tokens. */
  function diceTokens(leftTokens, rightTokens) {
    const a = new Set(leftTokens || []);
    const b = new Set(rightTokens || []);
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection += 1;
    }
    return (2 * intersection) / (a.size + b.size);
  }

  /**
   * For every token of the shorter title, finds the most similar token of the
   * longer one. This handles spelling variants (theatre/theater) and
   * morphological forms (watermelon/watermelons).
   */
  function tokenCoverage(leftTokens, rightTokens) {
    const a = new Set(leftTokens || []);
    const b = new Set(rightTokens || []);
    if (!a.size || !b.size) return { average: 0, coverage: 0, intersection: 0 };
    const shorter = a.size <= b.size ? a : b;
    const longer = a.size <= b.size ? b : a;
    let sum = 0;
    let covered = 0;
    let intersection = 0;
    for (const token of shorter) {
      if (longer.has(token)) {
        intersection += 1;
        sum += 1;
        covered += 1;
        continue;
      }
      let best = 0;
      for (const other of longer) {
        const similarity = diceBigrams(token, other);
        if (similarity > best) best = similarity;
        if (best >= 0.999) break;
      }
      sum += best;
      if (best >= 0.75) covered += 1;
    }
    return {
      average: sum / shorter.size,
      coverage: covered / shorter.size,
      intersection,
    };
  }

  /**
   * Combined name similarity in [0, 1].
   *
   * Character bigrams catch typos; token containment catches extra qualifiers
   * such as "(Easy Version)"; token coverage catches spelling variants.
   * A single-token title is only compared by characters, otherwise "Array"
   * would too easily match "Array Cloning Technique".
   */
  function nameSimilarity(leftNorm, rightNorm, leftTokens, rightTokens) {
    if (!leftNorm || !rightNorm) return 0;
    if (leftNorm === rightNorm) return 1;
    const leftTokensFinal = leftTokens || tokenize(leftNorm);
    const rightTokensFinal = rightTokens || tokenize(rightNorm);
    const characterScore = diceBigrams(leftNorm, rightNorm);
    const smallerSize = Math.min(leftTokensFinal.length, rightTokensFinal.length);
    if (smallerSize === 0) return characterScore;
    if (smallerSize === 1) return characterScore;

    const tokenStats = tokenCoverage(leftTokensFinal, rightTokensFinal);
    const containment = tokenStats.intersection /
      Math.min(new Set(leftTokensFinal).size, new Set(rightTokensFinal).size);
    return (
      0.40 * characterScore +
      0.28 * containment +
      0.22 * tokenStats.average +
      0.10 * tokenStats.coverage
    );
  }

  function countTokenOverlap(leftTokens, rightTokens) {
    const right = new Set(rightTokens || []);
    let count = 0;
    for (const token of leftTokens || []) {
      if (right.has(token)) count += 1;
    }
    return count;
  }

  /** Levenshtein distance on Unicode code points (two-row DP). */
  function levenshteinDistance(left, right) {
    const a = Array.from(String(left == null ? '' : left));
    const b = Array.from(String(right == null ? '' : right));
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    let previous = new Array(shorter.length + 1);
    let current = new Array(shorter.length + 1);
    for (let i = 0; i <= shorter.length; i += 1) previous[i] = i;
    for (let i = 1; i <= longer.length; i += 1) {
      current[0] = i;
      const code = longer[i - 1];
      for (let j = 1; j <= shorter.length; j += 1) {
        const substitution = previous[j - 1] + (shorter[j - 1] === code ? 0 : 1);
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      }
      const swap = previous;
      previous = current;
      current = swap;
    }
    return previous[shorter.length];
  }

  function levenshteinRatio(left, right) {
    const a = String(left == null ? '' : left);
    const b = String(right == null ? '' : right);
    if (a === b) return a ? 1 : 0;
    const longest = Math.max(Array.from(a).length, Array.from(b).length);
    if (!longest) return 0;
    return 1 - levenshteinDistance(a, b) / longest;
  }

  function normalizeHandle(value) {
    return String(value == null ? '' : value).trim().replace(/^@+/, '');
  }

  function isValidHandle(value) {
    return /^[A-Za-z0-9_.-]{1,64}$/.test(normalizeHandle(value));
  }

  return {
    STOPWORDS,
    stripIndexPrefix,
    normalizeTitle,
    normalizeLoose,
    normalizeCompact,
    tokenize,
    characterBigrams,
    diceBigrams,
    diceTokens,
    tokenCoverage,
    nameSimilarity,
    countTokenOverlap,
    levenshteinDistance,
    levenshteinRatio,
    normalizeHandle,
    isValidHandle,
  };
});
