/**
 * Plagiarism Detector Using Rolling Hash (Rabin–Karp) and Hash Maps
 * Production-grade client-side implementation.
 */

// ============================================================================
// Mathematical Constants & BigInt Hashing Setup
// ============================================================================
const RABIN_KARP_BASE = 31337n;
// Mersenne Prime 2^61 - 1: comfortably fits within 64-bit integer space,
// provides virtually zero chance of random polynomial hash collisions.
const RABIN_KARP_MOD = 2305843009213693951n;

/**
 * Hash an individual word token to a 32-bit positive integer using FNV-1a.
 * @param {string} word 
 * @returns {bigint}
 */
function hashWordToBigInt(word) {
  let hash = 2166136261n;
  for (let i = 0; i < word.length; i++) {
    hash ^= BigInt(word.charCodeAt(i));
    hash = (hash * 16777619n) & 0xffffffffn;
  }
  return hash;
}

/**
 * Fast modular exponentiation: (base^exp) % mod
 */
function modPow(base, exp, mod) {
  let res = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % mod;
    base = (base * base) % mod;
    exp /= 2n;
  }
  return res;
}

// ============================================================================
// Text Preprocessor & Tokenizer
// ============================================================================
class TextPreprocessor {
  /**
   * Tokenizes raw text into words while recording exact character start and end
   * offsets in the original raw string for precise visual highlight rendering.
   * @param {string} rawText 
   * @param {object} options 
   * @returns {Array<{word: string, normalized: string, start: number, end: number, id: bigint}>}
   */
  static tokenize(rawText, options = { caseFold: true, stripPunctuation: true }) {
    if (!rawText) return [];
    
    const tokens = [];
    // Match word sequences (supports unicode letters, numbers, apostrophes in contractions)
    const regex = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      const rawWord = match[0];
      const start = match.index;
      const end = start + rawWord.length;
      
      let normalized = rawWord;
      if (options.caseFold) {
        normalized = normalized.toLowerCase();
      }
      if (options.stripPunctuation) {
        // Strip hyphens, apostrophes from normalized comparison representation
        normalized = normalized.replace(/['’]/g, '');
      }

      tokens.push({
        word: rawWord,
        normalized: normalized,
        start: start,
        end: end,
        id: hashWordToBigInt(normalized)
      });
    }

    return tokens;
  }
}

// ============================================================================
// Rabin-Karp Rolling Hash Engine
// ============================================================================
class RabinKarpEngine {
  constructor(k = 5) {
    this.k = BigInt(k);
    this.base = RABIN_KARP_BASE;
    this.mod = RABIN_KARP_MOD;
    // Precompute b^(k-1) % mod for O(1) rolling updates
    this.highPower = modPow(this.base, this.k - 1n, this.mod);
  }

  setK(newK) {
    this.k = BigInt(newK);
    this.highPower = modPow(this.base, this.k - 1n, this.mod);
  }

  /**
   * Computes the polynomial hash of the first shingle from scratch in O(k):
   * H = sum(tokens[j].id * base^(k-1-j)) mod M
   */
  computeInitialHash(tokens, startIndex = 0) {
    let hash = 0n;
    for (let j = 0; j < Number(this.k); j++) {
      const tokenId = tokens[startIndex + j].id;
      hash = (hash * this.base + tokenId) % this.mod;
    }
    return (hash + this.mod) % this.mod;
  }

  /**
   * Rolls the hash window by one position in O(1):
   * H_{new} = ((H_{old} - evicted.id * base^(k-1)) * base + incoming.id) mod M
   */
  rollHash(oldHash, evictedTokenId, incomingTokenId) {
    // 1. Evict oldest word
    let termToRemove = (evictedTokenId * this.highPower) % this.mod;
    let intermediate = (oldHash - termToRemove) % this.mod;
    if (intermediate < 0n) intermediate += this.mod;

    // 2. Shift remaining words up by base and add new incoming word
    let newHash = (intermediate * this.base + incomingTokenId) % this.mod;
    if (newHash < 0n) newHash += this.mod;

    return newHash;
  }
}

// ============================================================================
// Hash Map Shingle Inverted Index
// ============================================================================
class ShingleIndex {
  constructor(k = 5) {
    this.k = k;
    this.engine = new RabinKarpEngine(k);
    // Map: Hash (BigInt) => Array of occurrences
    this.index = new Map();
    this.shingles = [];
  }

  /**
   * Index source text tokens using Rabin-Karp rolling hash.
   * Total time complexity: O(n) where n = number of tokens.
   */
  build(tokens, rawText) {
    this.index.clear();
    this.shingles = [];
    const n = tokens.length;
    if (n < this.k) return;

    // 1. Initial window
    let currentHash = this.engine.computeInitialHash(tokens, 0);
    this.addShingle(0, currentHash, tokens, rawText);

    // 2. Rolling subsequent windows in O(1) each
    for (let i = 1; i <= n - this.k; i++) {
      const evicted = tokens[i - 1].id;
      const incoming = tokens[i + this.k - 1].id;
      currentHash = this.engine.rollHash(currentHash, evicted, incoming);
      this.addShingle(i, currentHash, tokens, rawText);
    }
  }

  addShingle(startIndex, hash, tokens, rawText) {
    const endIndex = startIndex + this.k;
    const shingleTokens = tokens.slice(startIndex, endIndex);
    const charStart = shingleTokens[0].start;
    const charEnd = shingleTokens[this.k - 1].end;
    const rawSnippet = rawText.slice(charStart, charEnd);

    const shingleData = {
      index: startIndex,
      hash: hash,
      normalizedWords: shingleTokens.map(t => t.normalized),
      charStart: charStart,
      charEnd: charEnd,
      rawSnippet: rawSnippet
    };

    this.shingles.push(shingleData);

    const existing = this.index.get(hash);
    if (existing) {
      existing.push(shingleData);
    } else {
      this.index.set(hash, [shingleData]);
    }
  }

  /**
   * Lookup a shingle hash in O(1) average time, then verify against raw text
   * to guarantee zero false positives from hash collisions.
   */
  query(hash, checkedShingleTokens) {
    const candidates = this.index.get(hash);
    if (!candidates) return null;

    // Verification step: compare actual normalized words to eliminate collisions
    const targetWords = checkedShingleTokens.map(t => t.normalized);
    for (const cand of candidates) {
      let match = true;
      for (let j = 0; j < this.k; j++) {
        if (cand.normalizedWords[j] !== targetWords[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        return {
          verifiedMatch: true,
          sourceShingle: cand,
          candidateCount: candidates.length,
          collisionOccurred: candidates.length > 1 && !match
        };
      }
    }

    // Hash matched, but text verification failed (Hash Collision detected!)
    return {
      verifiedMatch: false,
      collisionOccurred: true,
      candidateCount: candidates.length
    };
  }
}

// ============================================================================
// Plagiarism Detection Engine
// ============================================================================
class PlagiarismDetector {
  /**
   * Compares sourceText and checkedText using rolling hash and hash map.
   */
  static compare(sourceText, checkedText, options = {}) {
    const k = options.k || 5;
    const caseFold = options.caseFold !== false;
    const stripPunctuation = options.stripPunctuation !== false;

    const startTime = performance.now();

    // 1. Tokenize texts
    const sourceTokens = TextPreprocessor.tokenize(sourceText, { caseFold, stripPunctuation });
    const checkedTokens = TextPreprocessor.tokenize(checkedText, { caseFold, stripPunctuation });

    // Handle edge cases
    if (sourceTokens.length === 0 || checkedTokens.length === 0) {
      return {
        error: "One or both texts contain no recognizable words.",
        emptyInput: true
      };
    }

    if (checkedTokens.length < k || sourceTokens.length < k) {
      return {
        error: `Text is shorter than the selected shingle size (${k} words). Please lower the shingle size or provide more text.`,
        insufficientTokens: true,
        sourceTokenCount: sourceTokens.length,
        checkedTokenCount: checkedTokens.length,
        k: k
      };
    }

    // 2. Build hash map index of source shingles in O(n)
    const sourceIndex = new ShingleIndex(k);
    sourceIndex.build(sourceTokens, sourceText);

    // 3. Scan checked text using rolling hash in O(m)
    const engine = new RabinKarpEngine(k);
    const m = checkedTokens.length;
    const totalCheckedShingles = m - k + 1;
    
    const matchedCheckedShingles = [];
    const matchedSourceIndices = new Set();
    let collisionChecks = 0;
    let collisionsAvoided = 0;

    // First shingle
    let currentHash = engine.computeInitialHash(checkedTokens, 0);
    const firstTokens = checkedTokens.slice(0, k);
    let checkResult = sourceIndex.query(currentHash, firstTokens);
    if (checkResult) {
      collisionChecks++;
      if (checkResult.verifiedMatch) {
        matchedCheckedShingles.push({
          checkIndex: 0,
          hash: currentHash,
          charStart: firstTokens[0].start,
          charEnd: firstTokens[k - 1].end,
          rawSnippet: checkedText.slice(firstTokens[0].start, firstTokens[k - 1].end),
          sourceMatch: checkResult.sourceShingle
        });
        matchedSourceIndices.add(checkResult.sourceShingle.index);
      } else if (checkResult.collisionOccurred) {
        collisionsAvoided++;
      }
    }

    // Roll through rest of checked text
    for (let i = 1; i <= m - k; i++) {
      const evicted = checkedTokens[i - 1].id;
      const incoming = checkedTokens[i + k - 1].id;
      currentHash = engine.rollHash(currentHash, evicted, incoming);
      const shingleTokens = checkedTokens.slice(i, i + k);
      checkResult = sourceIndex.query(currentHash, shingleTokens);
      if (checkResult) {
        collisionChecks++;
        if (checkResult.verifiedMatch) {
          matchedCheckedShingles.push({
            checkIndex: i,
            hash: currentHash,
            charStart: shingleTokens[0].start,
            charEnd: shingleTokens[k - 1].end,
            rawSnippet: checkedText.slice(shingleTokens[0].start, shingleTokens[k - 1].end),
            sourceMatch: checkResult.sourceShingle
          });
          matchedSourceIndices.add(checkResult.sourceShingle.index);
        } else if (checkResult.collisionOccurred) {
          collisionsAvoided++;
        }
      }
    }

    // 4. Calculate similarity metrics
    // Containment Score: proportion of checked shingles also found in source
    const containmentScore = totalCheckedShingles > 0 
      ? (matchedCheckedShingles.length / totalCheckedShingles) * 100 
      : 0;

    // Jaccard similarity: |Intersection| / |Union|
    const totalSourceShingles = sourceIndex.shingles.length;
    const intersectionCount = matchedCheckedShingles.length;
    const unionCount = (totalSourceShingles + totalCheckedShingles) - intersectionCount;
    const jaccardScore = unionCount > 0 ? (intersectionCount / unionCount) * 100 : 0;

    // Longest contiguous match streak
    let longestStreak = 0;
    let currentStreak = 0;
    let prevIndex = -999;
    for (const match of matchedCheckedShingles) {
      if (match.checkIndex === prevIndex + 1) {
        currentStreak++;
      } else {
        currentStreak = 1;
      }
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
      }
      prevIndex = match.checkIndex;
    }
    const longestMatchedWords = longestStreak > 0 ? longestStreak + k - 1 : 0;

    // 5. Coalesce matched intervals for clean dual-text highlighting
    const checkedIntervals = PlagiarismDetector.coalesceIntervals(
      matchedCheckedShingles.map(m => ({
        start: m.charStart,
        end: m.charEnd,
        sourceStart: m.sourceMatch.charStart,
        sourceEnd: m.sourceMatch.charEnd,
        checkIndex: m.checkIndex,
        sourceIndex: m.sourceMatch.index,
        hash: m.hash
      }))
    );

    const sourceIntervals = PlagiarismDetector.coalesceIntervals(
      matchedCheckedShingles.map(m => ({
        start: m.sourceMatch.charStart,
        end: m.sourceMatch.charEnd,
        sourceStart: m.sourceMatch.charStart,
        sourceEnd: m.sourceMatch.charEnd,
        checkIndex: m.checkIndex,
        sourceIndex: m.sourceMatch.index,
        hash: m.hash
      }))
    );

    const endTime = performance.now();

    return {
      success: true,
      containmentScore: Math.round(containmentScore * 10) / 10,
      jaccardScore: Math.round(jaccardScore * 10) / 10,
      totalCheckedShingles,
      totalSourceShingles,
      matchedShinglesCount: matchedCheckedShingles.length,
      matchedCheckedShingles,
      longestMatchedWords,
      checkedTokensCount: checkedTokens.length,
      sourceTokensCount: sourceTokens.length,
      collisionChecks,
      collisionsAvoided,
      checkedIntervals,
      sourceIntervals,
      elapsedMs: Math.round((endTime - startTime) * 100) / 100,
      k
    };
  }

  /**
   * Merge overlapping or adjacent character intervals into smooth continuous spans
   */
  static coalesceIntervals(intervals) {
    if (!intervals || intervals.length === 0) return [];
    
    // Sort by start position
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    const merged = [];
    let current = { ...sorted[0], matches: [sorted[0]] };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      // If next interval overlaps or is immediately adjacent
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
        current.matches.push(next);
      } else {
        merged.push(current);
        current = { ...next, matches: [next] };
      }
    }
    merged.push(current);
    return merged;
  }

  /**
   * Generates HTML with highlighted `<mark>` spans based on coalesced intervals.
   */
  static renderHighlightedText(rawText, intervals, paneType = 'checked') {
    if (!intervals || intervals.length === 0) {
      return PlagiarismDetector.escapeHtml(rawText);
    }

    let html = '';
    let lastIndex = 0;

    intervals.forEach((interval, idx) => {
      // Unmatched prefix
      if (interval.start > lastIndex) {
        html += PlagiarismDetector.escapeHtml(rawText.slice(lastIndex, interval.start));
      }
      // Matched span
      const matchedSnippet = PlagiarismDetector.escapeHtml(rawText.slice(interval.start, interval.end));
      const matchId = `match-${paneType}-${idx}`;
      const partnerId = `match-${paneType === 'checked' ? 'source' : 'checked'}-${idx}`;
      
      html += `<mark class="match-span" id="${matchId}" data-pane="${paneType}" data-idx="${idx}" title="Click to inspect matching passage in other document">${matchedSnippet}</mark>`;
      lastIndex = interval.end;
    });

    // Unmatched suffix
    if (lastIndex < rawText.length) {
      html += PlagiarismDetector.escapeHtml(rawText.slice(lastIndex));
    }

    return html;
  }

  static escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// ============================================================================
// Pre-loaded Educational Example Documents
// ============================================================================
const DEMO_PRESETS = {
  direct_plagiarism: {
    name: "Direct Verbatim Plagiarism (Rearranged)",
    source: `Artificial intelligence has fundamentally transformed computational linguistics over the past decade. Traditional rule-based systems relied on hand-crafted grammars and extensive expert heuristics. In modern architectures, deep neural networks learn latent semantic representations directly from massive text corpora without manual intervention.

One pivotal breakthrough was the self-attention mechanism introduced in the Transformer model. Rather than processing sequential tokens strictly one step at a time, self-attention evaluates all pairs of tokens in parallel, dynamically weighting inter-word dependencies regardless of their positional distance. This architecture drastically reduced training bottlenecks on modern graphics processing hardware.

Consequently, large language models can perform diverse downstream natural language understanding tasks with remarkable fluency, including summarization, question answering, and automated translation.`,
    check: `The self-attention mechanism introduced in the Transformer model was a pivotal breakthrough. Rather than processing sequential tokens strictly one step at a time, self-attention evaluates all pairs of tokens in parallel, dynamically weighting inter-word dependencies regardless of their positional distance. This architecture drastically reduced training bottlenecks on modern graphics processing hardware.

Indeed, artificial intelligence has fundamentally transformed computational linguistics over the past decade. Traditional rule-based systems relied on hand-crafted grammars and extensive expert heuristics.

Furthermore, students now explore neural approaches across various scientific and academic domains.`
  },

  partial_plagiarism: {
    name: "Partial Plagiarism (Copied Passages with Minor Edits)",
    source: `Photosynthesis is the fundamental biological process through which photoautotrophs convert radiant solar energy into chemical energy stored in glucose molecules. In oxygenic photosynthesis, water serves as the primary electron donor, yielding molecular oxygen as an environmental byproduct. 

This complex thermodynamic process takes place inside cellular organelles called chloroplasts. Embedded within the thylakoid membranes are two distinct photosystems, known as Photosystem I and Photosystem II, containing specialized light-harvesting pigment complexes centered around chlorophyll a molecules. When photons strike these antenna complexes, electrons are elevated to higher energy orbital states and shuttled along an electron transport chain.`,
    check: `In our biological laboratory investigation, our team investigated how plants capture solar radiation. Photosynthesis is the fundamental biological process through which photoautotrophs convert radiant solar energy into chemical energy stored in glucose molecules. In oxygenic photosynthesis, water serves as the primary electron donor, yielding molecular oxygen as an environmental byproduct.

Our experiments confirmed this behavior under varying light spectrums. Embedded within the thylakoid membranes are two distinct photosystems, known as Photosystem I and Photosystem II, containing specialized light-harvesting pigment complexes centered around chlorophyll a molecules. These observations align well with published literature on plant cellular respiration.`
  },

  paraphrased_limitations: {
    name: "Paraphrased Content (Demonstrating Limitations)",
    source: `Renewable energy sources such as solar and wind power are essential for mitigating global climate change. Transitioning away from carbon-intensive fossil fuels reduces greenhouse gas emissions and fosters long-term ecological sustainability. However, high initial capital investment and grid integration challenges remain significant obstacles for developing nations.`,
    check: `Clean energy alternatives like sunlight and wind turbines play a vital part in combating worldwide climate warming. Moving away from dirty petroleum products lowers toxic carbon emissions and encourages enduring environmental balance. Nonetheless, expensive upfront startup costs and electrical grid modernization issues present major barriers for emerging economies.`
  },

  independent_texts: {
    name: "Completely Independent Topics (0% Overlap)",
    source: `The James Webb Space Telescope (JWST) represents an extraordinary feat of infrared astronomy. Operating at the second Sun-Earth Lagrange point approximately 1.5 million kilometers from Earth, its segmented beryllium mirror and cryocooled detectors observe the earliest galaxies formed after the Big Bang.`,
    check: `The Renaissance was a vibrant period of European cultural, artistic, political and economic rebirth following the Middle Ages. Spanning roughly from the 14th century to the 17th century, it promoted the rediscovery of classical philosophy, literature, and art in Italian city-states like Florence.`
  }
};

// ============================================================================
// Interactive Rolling Hash Visualizer Sandbox
// ============================================================================
class VisualizerSandbox {
  constructor() {
    this.sentence = "The quick brown fox jumps over the lazy dog in the park";
    this.k = 4;
    this.currentIndex = 0;
    this.isPlaying = false;
    this.timer = null;
    this.speed = 1200; // ms per step

    this.engine = new RabinKarpEngine(this.k);
    this.tokens = [];
    this.hashMap = new Map();

    this.initElements();
    this.bindEvents();
    this.loadSentence(this.sentence);
  }

  initElements() {
    this.sentenceInput = document.getElementById('viz-sentence-input');
    this.kInput = document.getElementById('viz-k-input');
    this.kValue = document.getElementById('viz-k-val');
    this.tokensTrack = document.getElementById('viz-tokens-track');
    this.playBtn = document.getElementById('viz-btn-play');
    this.stepPrevBtn = document.getElementById('viz-btn-prev');
    this.stepNextBtn = document.getElementById('viz-btn-next');
    this.resetBtn = document.getElementById('viz-btn-reset');
    this.speedSlider = document.getElementById('viz-speed-slider');
    
    // Math elements
    this.windowWordsSpan = document.getElementById('viz-window-words');
    this.currentHashSpan = document.getElementById('viz-current-hash');
    this.evictedRow = document.getElementById('viz-evicted-row');
    this.evictedWordSpan = document.getElementById('viz-evicted-word');
    this.evictedTermSpan = document.getElementById('viz-evicted-term');
    this.incomingRow = document.getElementById('viz-incoming-row');
    this.incomingWordSpan = document.getElementById('viz-incoming-word');
    this.incomingTermSpan = document.getElementById('viz-incoming-term');
    this.finalHashSpan = document.getElementById('viz-final-hash');
    this.hashBucketsPreview = document.getElementById('viz-hashmap-buckets');
    this.stepIndicator = document.getElementById('viz-step-counter');
  }

  bindEvents() {
    if (!this.sentenceInput) return;

    this.sentenceInput.addEventListener('change', () => {
      this.loadSentence(this.sentenceInput.value);
    });

    this.kInput.addEventListener('input', (e) => {
      this.k = parseInt(e.target.value, 10);
      if (this.kValue) this.kValue.textContent = this.k;
      this.engine.setK(this.k);
      this.loadSentence(this.sentence);
    });

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.stepPrevBtn.addEventListener('click', () => this.stepBackward());
    this.stepNextBtn.addEventListener('click', () => this.stepForward());
    this.resetBtn.addEventListener('click', () => this.reset());

    if (this.speedSlider) {
      this.speedSlider.addEventListener('input', (e) => {
        this.speed = parseInt(e.target.value, 10);
        if (this.isPlaying) {
          this.pause();
          this.play();
        }
      });
    }
  }

  loadSentence(text) {
    this.pause();
    this.sentence = text.trim() || "The quick brown fox jumps over the lazy dog";
    this.tokens = TextPreprocessor.tokenize(this.sentence, { caseFold: true, stripPunctuation: true });
    
    if (this.tokens.length < this.k) {
      this.k = Math.max(2, this.tokens.length);
      if (this.kInput) this.kInput.value = this.k;
      if (this.kValue) this.kValue.textContent = this.k;
      this.engine.setK(this.k);
    }

    this.hashMap.clear();
    this.currentIndex = 0;
    this.renderTokensTrack();
    this.updateStep();
  }

  renderTokensTrack() {
    if (!this.tokensTrack) return;
    this.tokensTrack.innerHTML = '';
    
    this.tokens.forEach((token, idx) => {
      const pill = document.createElement('div');
      pill.className = 'token-pill';
      pill.id = `viz-token-${idx}`;
      
      const wordSpan = document.createElement('span');
      wordSpan.className = 'token-word';
      wordSpan.textContent = token.word;

      const idSpan = document.createElement('span');
      idSpan.className = 'token-id';
      // Short 4-char hex of token ID for pedagogical clarity
      idSpan.textContent = `#${(token.id % 65535n).toString(16)}`;

      pill.appendChild(wordSpan);
      pill.appendChild(idSpan);
      this.tokensTrack.appendChild(pill);
    });
  }

  updateStep() {
    const totalWindows = this.tokens.length - this.k + 1;
    if (this.stepIndicator) {
      this.stepIndicator.textContent = `Window ${this.currentIndex + 1} of ${totalWindows}`;
    }

    // Clear previous visual classes
    this.tokens.forEach((_, idx) => {
      const pill = document.getElementById(`viz-token-${idx}`);
      if (pill) {
        pill.className = 'token-pill';
      }
    });

    const windowEnd = this.currentIndex + this.k;
    const windowTokens = this.tokens.slice(this.currentIndex, windowEnd);
    const windowWords = windowTokens.map(t => t.word).join(' ');

    // Highlight active window
    for (let i = this.currentIndex; i < windowEnd; i++) {
      const pill = document.getElementById(`viz-token-${i}`);
      if (pill) pill.classList.add('in-window');
    }

    if (this.windowWordsSpan) {
      this.windowWordsSpan.textContent = `"${windowWords}"`;
    }

    // Step 0: Compute initial polynomial hash
    if (this.currentIndex === 0) {
      const initialHash = this.engine.computeInitialHash(this.tokens, 0);
      this.currentHash = initialHash;

      if (this.currentHashSpan) this.currentHashSpan.textContent = `${initialHash}`;
      if (this.evictedRow) this.evictedRow.style.display = 'none';
      if (this.incomingRow) this.incomingRow.style.display = 'none';
      if (this.finalHashSpan) this.finalHashSpan.textContent = `${initialHash}`;

      // Insert to map
      this.addToHashMap(initialHash, windowWords, this.currentIndex);
    } else {
      // Rolling step
      const evictedToken = this.tokens[this.currentIndex - 1];
      const incomingToken = this.tokens[windowEnd - 1];

      // Highlight evicted & incoming visually
      const evictedPill = document.getElementById(`viz-token-${this.currentIndex - 1}`);
      const incomingPill = document.getElementById(`viz-token-${windowEnd - 1}`);
      if (evictedPill) evictedPill.classList.add('evicted');
      if (incomingPill) incomingPill.classList.add('incoming');

      const oldHash = this.engine.computeInitialHash(this.tokens, this.currentIndex - 1);
      const newHash = this.engine.rollHash(oldHash, evictedToken.id, incomingToken.id);
      this.currentHash = newHash;

      if (this.currentHashSpan) this.currentHashSpan.textContent = `${oldHash}`;
      if (this.evictedRow) {
        this.evictedRow.style.display = 'flex';
        this.evictedWordSpan.textContent = `"${evictedToken.word}"`;
        this.evictedTermSpan.textContent = `- (${evictedToken.id % 9999n} × b^${this.k - 1})`;
      }
      if (this.incomingRow) {
        this.incomingRow.style.display = 'flex';
        this.incomingWordSpan.textContent = `"${incomingToken.word}"`;
        this.incomingTermSpan.textContent = `+ ${incomingToken.id % 9999n}`;
      }
      if (this.finalHashSpan) {
        this.finalHashSpan.textContent = `${newHash}`;
      }

      this.addToHashMap(newHash, windowWords, this.currentIndex);
    }

    this.renderHashMapBuckets();
  }

  addToHashMap(hash, words, index) {
    const key = `0x${(hash % 0xffffffn).toString(16).toUpperCase()}`;
    if (!this.hashMap.has(key)) {
      this.hashMap.set(key, []);
    }
    this.hashMap.get(key).push({ words, index });
  }

  renderHashMapBuckets() {
    if (!this.hashBucketsPreview) return;
    this.hashBucketsPreview.innerHTML = '';
    
    this.hashMap.forEach((entries, key) => {
      const row = document.createElement('div');
      row.className = 'bucket-row';
      row.innerHTML = `
        <span class="bucket-key">${key}</span>
        <span class="bucket-val">${entries.map(e => `[${e.index}: "${e.words}"]`).join(', ')}</span>
      `;
      this.hashBucketsPreview.appendChild(row);
    });
  }

  stepForward() {
    const maxIndex = this.tokens.length - this.k;
    if (this.currentIndex < maxIndex) {
      this.currentIndex++;
      this.updateStep();
    } else {
      this.pause();
    }
  }

  stepBackward() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.updateStep();
    }
  }

  reset() {
    this.pause();
    this.currentIndex = 0;
    this.hashMap.clear();
    this.updateStep();
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    const maxIndex = this.tokens.length - this.k;
    if (this.currentIndex >= maxIndex) {
      this.currentIndex = 0;
      this.hashMap.clear();
      this.updateStep();
    }
    this.isPlaying = true;
    if (this.playBtn) this.playBtn.innerHTML = `<span>⏸</span> Pause`;

    this.timer = setInterval(() => {
      if (this.currentIndex < this.tokens.length - this.k) {
        this.stepForward();
      } else {
        this.pause();
      }
    }, this.speed);
  }

  pause() {
    this.isPlaying = false;
    if (this.playBtn) this.playBtn.innerHTML = `<span>▶</span> Play`;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ============================================================================
// Main UI Controller & Event Coordination
// ============================================================================
class AppController {
  constructor() {
    this.shingleK = 5;
    this.lastComparisonResult = null;
    this.initDOMReferences();
    this.bindEvents();
    this.initVisualizer();
    this.initComplexityCalculator();
    this.loadDefaultDemo();
    this.initTheme();
  }

  initDOMReferences() {
    // Inputs & Buttons
    this.sourceTextEl = document.getElementById('source-text-input');
    this.checkTextEl = document.getElementById('check-text-input');
    this.compareBtn = document.getElementById('compare-btn');
    this.clearBtn = document.getElementById('clear-btn');
    this.swapBtn = document.getElementById('swap-btn');
    this.presetSelect = document.getElementById('preset-select');
    
    // Shingle controls
    this.shingleSlider = document.getElementById('shingle-slider');
    this.shingleValBadge = document.getElementById('shingle-val-badge');
    this.shingleHintText = document.getElementById('shingle-hint-text');
    this.presetChips = document.querySelectorAll('.preset-chip');

    // Panes & Views
    this.sourcePane = document.getElementById('source-pane');
    this.checkPane = document.getElementById('check-pane');
    this.sourceHighlightView = document.getElementById('source-highlight-view');
    this.checkHighlightView = document.getElementById('check-highlight-view');
    this.sourceTabEdit = document.getElementById('source-tab-edit');
    this.sourceTabHighlight = document.getElementById('source-tab-highlight');
    this.checkTabEdit = document.getElementById('check-tab-edit');
    this.checkTabHighlight = document.getElementById('check-tab-highlight');

    // Stats badges
    this.sourceWordCount = document.getElementById('source-word-count');
    this.sourceShingleCount = document.getElementById('source-shingle-count');
    this.checkWordCount = document.getElementById('check-word-count');
    this.checkShingleCount = document.getElementById('check-shingle-count');

    // Results Dashboard
    this.resultsContainer = document.getElementById('results-container');
    this.scorePercentEl = document.getElementById('score-percent');
    this.scoreVerdictBadge = document.getElementById('score-verdict-badge');
    this.gaugeProgressCircle = document.getElementById('gauge-progress-circle');
    
    // Secondary Metrics
    this.metricMatchedShingles = document.getElementById('metric-matched-shingles');
    this.metricTotalShingles = document.getElementById('metric-total-shingles');
    this.metricLongestRun = document.getElementById('metric-longest-run');
    this.metricJaccard = document.getElementById('metric-jaccard');
    this.metricCollisions = document.getElementById('metric-collisions');
    this.metricTime = document.getElementById('metric-time');

    // Matched table & export
    this.matchedTableBody = document.getElementById('matched-table-body');
    this.tableSearchInput = document.getElementById('table-search-input');
    this.exportReportBtn = document.getElementById('export-report-btn');
    this.copySummaryBtn = document.getElementById('copy-summary-btn');

    // Theme toggle
    this.themeToggleBtn = document.getElementById('theme-toggle-btn');
  }

  bindEvents() {
    // Compare Button
    this.compareBtn.addEventListener('click', () => this.runComparison());

    // Clear Button
    this.clearBtn.addEventListener('click', () => this.clearAll());

    // Swap Button
    this.swapBtn.addEventListener('click', () => this.swapTexts());

    // Preset Selection Dropdown
    this.presetSelect.addEventListener('change', (e) => {
      const presetKey = e.target.value;
      if (DEMO_PRESETS[presetKey]) {
        this.loadPreset(DEMO_PRESETS[presetKey]);
      }
    });

    // Shingle Size Slider & Preset Chips
    this.shingleSlider.addEventListener('input', (e) => {
      this.updateShingleSize(parseInt(e.target.value, 10));
    });

    this.presetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const k = parseInt(chip.dataset.k, 10);
        this.shingleSlider.value = k;
        this.updateShingleSize(k);
      });
    });

    // Real-time text statistics on typing
    const updateStats = () => this.updateTextStats();
    this.sourceTextEl.addEventListener('input', updateStats);
    this.checkTextEl.addEventListener('input', updateStats);

    // View Tabs (Editor vs Highlights)
    this.sourceTabEdit.addEventListener('click', () => this.switchView('source', 'edit'));
    this.sourceTabHighlight.addEventListener('click', () => this.switchView('source', 'highlight'));
    this.checkTabEdit.addEventListener('click', () => this.switchView('check', 'edit'));
    this.checkTabHighlight.addEventListener('click', () => this.switchView('check', 'highlight'));

    // Table Search Filter
    if (this.tableSearchInput) {
      this.tableSearchInput.addEventListener('input', (e) => {
        this.filterMatchedTable(e.target.value);
      });
    }

    // Export & Copy
    if (this.exportReportBtn) {
      this.exportReportBtn.addEventListener('click', () => this.exportJsonReport());
    }
    if (this.copySummaryBtn) {
      this.copySummaryBtn.addEventListener('click', () => this.copySummaryToClipboard());
    }

    // Theme Toggle
    if (this.themeToggleBtn) {
      this.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
    }
  }

  initVisualizer() {
    this.visualizer = new VisualizerSandbox();
  }

  initComplexityCalculator() {
    const inputN = document.getElementById('calc-n');
    const inputM = document.getElementById('calc-m');
    const rkOpsEl = document.getElementById('calc-rk-ops');
    const naiveOpsEl = document.getElementById('calc-naive-ops');
    const speedupEl = document.getElementById('calc-speedup');

    if (!inputN || !inputM) return;

    const recalc = () => {
      const n = Math.max(10, parseInt(inputN.value, 10) || 5000);
      const m = Math.max(10, parseInt(inputM.value, 10) || 3000);
      const k = this.shingleK;

      // Rabin-Karp operations: O(n + m)
      const rkOps = n + m;
      // Naive brute-force string search: O(n * m * k)
      const naiveOps = n * m * k;
      const speedup = Math.round(naiveOps / rkOps);

      rkOpsEl.textContent = `${rkOps.toLocaleString()} ops`;
      naiveOpsEl.textContent = `${naiveOps.toLocaleString()} ops`;
      speedupEl.textContent = `${speedup.toLocaleString()}× faster`;
    };

    inputN.addEventListener('input', recalc);
    inputM.addEventListener('input', recalc);
    recalc();
  }

  updateShingleSize(k) {
    this.shingleK = k;
    if (this.shingleValBadge) this.shingleValBadge.textContent = k;

    // Update active state on preset chips
    this.presetChips.forEach(chip => {
      chip.classList.toggle('active', parseInt(chip.dataset.k, 10) === k);
    });

    // Pedagogical dynamic hint
    let hint = "";
    if (k <= 3) {
      hint = "High sensitivity. Catches short phrases and fragments, but may flag common grammatical idioms.";
    } else if (k <= 6) {
      hint = "Balanced standard setting. Ideal for detecting copied clauses and partial sentences.";
    } else if (k <= 9) {
      hint = "High specificity. Detects complete sentences with high confidence, ignoring common phrasings.";
    } else {
      hint = "Verbatim passage mode. Requires substantial uninterrupted copying to trigger a match.";
    }
    if (this.shingleHintText) this.shingleHintText.textContent = hint;

    // Re-run if texts are populated
    if (this.sourceTextEl.value.trim() && this.checkTextEl.value.trim()) {
      this.runComparison();
    }
  }

  loadDefaultDemo() {
    this.loadPreset(DEMO_PRESETS.direct_plagiarism);
  }

  loadPreset(preset) {
    this.sourceTextEl.value = preset.source;
    this.checkTextEl.value = preset.check;
    this.updateTextStats();
    this.runComparison();
  }

  clearAll() {
    this.sourceTextEl.value = '';
    this.checkTextEl.value = '';
    this.sourceHighlightView.innerHTML = '';
    this.checkHighlightView.innerHTML = '';
    this.switchView('source', 'edit');
    this.switchView('check', 'edit');
    this.resultsContainer.classList.remove('visible');
    this.updateTextStats();
  }

  swapTexts() {
    const temp = this.sourceTextEl.value;
    this.sourceTextEl.value = this.checkTextEl.value;
    this.checkTextEl.value = temp;
    this.updateTextStats();
    if (this.sourceTextEl.value.trim() && this.checkTextEl.value.trim()) {
      this.runComparison();
    }
  }

  updateTextStats() {
    const sTokens = TextPreprocessor.tokenize(this.sourceTextEl.value);
    const cTokens = TextPreprocessor.tokenize(this.checkTextEl.value);

    this.sourceWordCount.textContent = `${sTokens.length} words`;
    this.sourceShingleCount.textContent = `${Math.max(0, sTokens.length - this.shingleK + 1)} shingles`;

    this.checkWordCount.textContent = `${cTokens.length} words`;
    this.checkShingleCount.textContent = `${Math.max(0, cTokens.length - this.shingleK + 1)} shingles`;
  }

  switchView(paneType, mode) {
    const pane = paneType === 'source' ? this.sourcePane : this.checkPane;
    const tabEdit = paneType === 'source' ? this.sourceTabEdit : this.checkTabEdit;
    const tabHighlight = paneType === 'source' ? this.sourceTabHighlight : this.checkTabHighlight;

    if (mode === 'highlight') {
      pane.classList.add('show-highlights');
      tabEdit.classList.remove('active');
      tabHighlight.classList.add('active');
    } else {
      pane.classList.remove('show-highlights');
      tabEdit.classList.add('active');
      tabHighlight.classList.remove('active');
    }
  }

  runComparison() {
    const sourceText = this.sourceTextEl.value;
    const checkText = this.checkTextEl.value;

    if (!sourceText.trim() || !checkText.trim()) {
      alert("Please provide both a Source Text and a Text to Check to begin comparison.");
      return;
    }

    const res = PlagiarismDetector.compare(sourceText, checkText, { k: this.shingleK });

    if (res.error) {
      alert(res.error);
      return;
    }

    this.lastComparisonResult = res;

    // Render Highlights
    this.sourceHighlightView.innerHTML = PlagiarismDetector.renderHighlightedText(
      sourceText, 
      res.sourceIntervals, 
      'source'
    );
    this.checkHighlightView.innerHTML = PlagiarismDetector.renderHighlightedText(
      checkText, 
      res.checkedIntervals, 
      'checked'
    );

    // Switch both panes to Highlight mode for immediate visual confirmation
    this.switchView('source', 'highlight');
    this.switchView('check', 'highlight');

    // Bind interactive synchronized hover/click
    this.bindHighlightInteractions();

    // Render Dashboard Metrics
    this.renderMetrics(res);

    // Render Matched Chunks Table
    this.renderMatchedTable(res.matchedCheckedShingles);

    // Reveal results section
    this.resultsContainer.classList.add('visible');
    this.resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderMetrics(res) {
    const score = res.containmentScore;
    this.scorePercentEl.textContent = `${score}%`;

    // Radial gauge calculation: circumference = 2 * PI * 58 ≈ 364.42
    const circumference = 364.42;
    const offset = circumference - (score / 100) * circumference;
    this.gaugeProgressCircle.style.strokeDashoffset = offset;

    // Dynamic color and verdict classification
    let color = '#10b981'; // Green (< 15%)
    let verdictText = "Minimal Overlap (< 15%)";
    let verdictClass = "badge-success";

    if (score >= 70) {
      color = '#ef4444'; // Red
      verdictText = "Extensive Verbatim Overlap (≥ 70%)";
      verdictClass = "badge-danger";
      this.scoreVerdictBadge.style.backgroundColor = 'var(--danger-bg)';
      this.scoreVerdictBadge.style.color = 'var(--danger-text)';
      this.scoreVerdictBadge.style.borderColor = 'var(--danger-border)';
    } else if (score >= 35) {
      color = '#f59e0b'; // Amber
      verdictText = "Substantial Shared Content (35% – 69%)";
      verdictClass = "badge-warning";
      this.scoreVerdictBadge.style.backgroundColor = 'var(--warning-bg)';
      this.scoreVerdictBadge.style.color = 'var(--warning-text)';
      this.scoreVerdictBadge.style.borderColor = 'var(--warning-border)';
    } else if (score >= 15) {
      color = '#3b82f6'; // Blue
      verdictText = "Moderate Common Phrasing (15% – 34%)";
      verdictClass = "badge-primary";
      this.scoreVerdictBadge.style.backgroundColor = 'var(--accent-light)';
      this.scoreVerdictBadge.style.color = 'var(--accent-primary)';
      this.scoreVerdictBadge.style.borderColor = 'var(--accent-border)';
    } else {
      this.scoreVerdictBadge.style.backgroundColor = 'var(--success-bg)';
      this.scoreVerdictBadge.style.color = 'var(--success-text)';
      this.scoreVerdictBadge.style.borderColor = 'var(--success-border)';
    }

    this.gaugeProgressCircle.style.stroke = color;
    this.scoreVerdictBadge.textContent = verdictText;

    // Secondary cards
    this.metricMatchedShingles.textContent = `${res.matchedShinglesCount}`;
    this.metricTotalShingles.textContent = `${res.totalCheckedShingles}`;
    this.metricLongestRun.textContent = `${res.longestMatchedWords} words`;
    this.metricJaccard.textContent = `${res.jaccardScore}%`;
    this.metricCollisions.textContent = `${res.collisionsAvoided} resolved`;
    this.metricTime.textContent = `${res.elapsedMs} ms`;
  }

  bindHighlightInteractions() {
    const checkedSpans = this.checkHighlightView.querySelectorAll('.match-span');
    const sourceSpans = this.sourceHighlightView.querySelectorAll('.match-span');

    const clearActive = () => {
      checkedSpans.forEach(s => s.classList.remove('active-inspect'));
      sourceSpans.forEach(s => s.classList.remove('active-inspect'));
    };

    checkedSpans.forEach(span => {
      span.addEventListener('click', () => {
        clearActive();
        span.classList.add('active-inspect');
        const idx = span.dataset.idx;
        const targetSourceSpan = this.sourceHighlightView.querySelector(`.match-span[data-idx="${idx}"]`);
        if (targetSourceSpan) {
          targetSourceSpan.classList.add('active-inspect');
          targetSourceSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });

    sourceSpans.forEach(span => {
      span.addEventListener('click', () => {
        clearActive();
        span.classList.add('active-inspect');
        const idx = span.dataset.idx;
        const targetCheckSpan = this.checkHighlightView.querySelector(`.match-span[data-idx="${idx}"]`);
        if (targetCheckSpan) {
          targetCheckSpan.classList.add('active-inspect');
          targetCheckSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
  }

  renderMatchedTable(matches) {
    if (!this.matchedTableBody) return;
    this.matchedTableBody.innerHTML = '';

    if (!matches || matches.length === 0) {
      this.matchedTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">
            No matching shingles detected between the documents with current shingle size (k = ${this.shingleK}).
          </td>
        </tr>
      `;
      return;
    }

    matches.forEach((m, idx) => {
      const row = document.createElement('tr');
      const hashHex = `0x${(m.hash % 0xffffffffffffn).toString(16).toUpperCase()}`;
      
      row.innerHTML = `
        <td style="font-family: var(--font-mono); color: var(--text-muted); font-size: 0.75rem;">#${idx + 1}</td>
        <td><span class="shingle-text-snippet">"${PlagiarismDetector.escapeHtml(m.rawSnippet)}"</span></td>
        <td><code class="hash-cell">${hashHex}</code></td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-secondary);">
          Src: #${m.sourceMatch.index} &rarr; Chk: #${m.checkIndex}
        </td>
        <td>
          <span class="verified-pill">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Verified (0 Collisions)
          </span>
        </td>
      `;
      this.matchedTableBody.appendChild(row);
    });
  }

  filterMatchedTable(query) {
    const q = query.toLowerCase().trim();
    const rows = this.matchedTableBody.querySelectorAll('tr');
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  }

  exportJsonReport() {
    if (!this.lastComparisonResult) return;
    const reportData = {
      project: "Plagiarism Detector Using Rolling Hash (Rabin-Karp) and Hash Maps",
      timestamp: new Date().toISOString(),
      shingleSize: this.shingleK,
      similarityScore: `${this.lastComparisonResult.containmentScore}%`,
      jaccardIndex: `${this.lastComparisonResult.jaccardScore}%`,
      metrics: {
        totalCheckedShingles: this.lastComparisonResult.totalCheckedShingles,
        totalSourceShingles: this.lastComparisonResult.totalSourceShingles,
        matchedShingles: this.lastComparisonResult.matchedShinglesCount,
        longestWordStreak: this.lastComparisonResult.longestMatchedWords,
        executionTimeMs: this.lastComparisonResult.elapsedMs
      },
      matches: this.lastComparisonResult.matchedCheckedShingles.map(m => ({
        checkIndex: m.checkIndex,
        sourceIndex: m.sourceMatch.index,
        hash: m.hash.toString(),
        snippet: m.rawSnippet
      }))
    };

    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plagiarism-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  copySummaryToClipboard() {
    if (!this.lastComparisonResult) return;
    const summary = `Plagiarism Analysis Report
Algorithm: Rabin-Karp Polynomial Rolling Hash + Hash Map Inverted Index
Shingle Size (k): ${this.shingleK} words
Similarity Score: ${this.lastComparisonResult.containmentScore}% (Containment)
Jaccard Index: ${this.lastComparisonResult.jaccardScore}%
Matched Shingles: ${this.lastComparisonResult.matchedShinglesCount} / ${this.lastComparisonResult.totalCheckedShingles}
Longest Copied Run: ${this.lastComparisonResult.longestMatchedWords} words
Collisions Resolved: ${this.lastComparisonResult.collisionsAvoided}
Note: Automated similarity indicator only. Scholarly intent and quotations require human educator review.`;

    navigator.clipboard.writeText(summary).then(() => {
      alert("Analysis summary copied to clipboard!");
    }).catch(err => {
      console.error(err);
    });
  }

  initTheme() {
    const savedTheme = localStorage.getItem('veri_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeButton(savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('veri_theme', next);
    this.updateThemeButton(next);
  }

  updateThemeButton(theme) {
    if (!this.themeToggleBtn) return;
    this.themeToggleBtn.innerHTML = theme === 'dark' 
      ? `<span>☀️</span> Light Theme` 
      : `<span>🌙</span> Dark Theme`;
  }
}

// Bootstrap once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.appController = new AppController();
});
