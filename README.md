# Plagiarism Detector Using Rolling Hash (Rabin–Karp) and Hash Maps

An interactive, responsive academic web application demonstrating exact and near-exact plagiarism detection using word shingling, the Rabin–Karp polynomial rolling hash algorithm, and hash-map inverted indexing.

---

## 📌 Project Overview

This application is designed for students, educators, and computer science researchers to explore how modern text similarity and plagiarism detection engines operate under the hood.

Rather than relying on black-box neural similarity metrics or sluggish brute-force string searches, this project demonstrates a mathematically rigorous, deterministic pipeline:
1. **Preprocessing & Tokenization:** Case folding, punctuation normalization, and token-offset mapping.
2. **Word Shingling (N-Grams):** Segmenting text into overlapping consecutive word sequences of length $k$.
3. **Rabin–Karp Rolling Hash:** Fingerprinting each shingle in $O(1)$ constant time per shift using polynomial modular arithmetic.
4. **Hash Map Inverted Indexing:** Storing source fingerprints in a hash table for $O(1)$ average lookup time.
5. **Exact Collision Verification:** Comparing raw shingle strings upon hash matches to guarantee zero false positives.
6. **Similarity Scoring & Synchronized Highlight Reconstruction:** Calculating containment metrics and rendering interactive, synchronized highlighted spans across both documents.

---

## 🚀 Key Features

- **Side-by-Side Document Comparison:**
  - Dual text areas for **Source Text** (original/corpus) and **Text to Check** (suspect text).
  - Configurable Shingle Size ($k$, default 5, range 2–15) with quick presets and dynamic sensitivity hints.
  - "Compare Texts", "Swap Texts", and "Clear" actions.
- **Preloaded Educational Scenarios:**
  - *Direct Verbatim Plagiarism (Rearranged Paragraphs):* Demonstrates position-independent detection of moved text.
  - *Partial Plagiarism (Copied Passages with Minor Edits):* Simulates student essays mixing original commentary with lifted excerpts.
  - *Paraphrased Content (Demonstrating Limitations):* Highlights how synonym substitution bypasses exact n-gram matching.
  - *Completely Independent Topics (0% Overlap):* Verifies baseline specificity.
- **Similarity Analytics Dashboard:**
  - Circular animated SVG gauge displaying **Containment Score**:
    $$\text{Containment Score} = \frac{|S_{\text{checked}} \cap S_{\text{source}}|}{|S_{\text{checked}}|} \times 100\%$$
  - Jaccard similarity index: $|S_{\text{checked}} \cap S_{\text{source}}| / |S_{\text{checked}} \cup S_{\text{source}}|$.
  - Longest contiguous matched word streak.
  - Collision verification counter (confirming zero false positives).
  - Client-side execution timer in milliseconds.
- **Synchronized Dual Highlighting:**
  - Overlapping shingles are coalesced into continuous highlight spans.
  - Clicking any highlighted passage in the Checked Text highlights and scrolls to the corresponding origin in the Source Text.
- **Matched Chunks Table & Export:**
  - Searchable list of matched word sequences with 64-bit hex hash values and document positions.
  - "Copy Summary" and "Export JSON Report" features.
- **Interactive Rolling Hash Visualizer:**
  - Step-by-step animated sandbox showing a sliding window traversing a sentence.
  - Real-time arithmetic breakdown showing eviction of $w_{\text{out}}$, shift by base $b$, addition of $w_{\text{in}}$, and modulo $M$.
  - Live Hash Map viewer showing buckets populated on the fly.
- **Interactive Big-O Calculator:**
  - Real-time comparison between Rabin-Karp $O(n+m)$ vs naive string matching $O(n \cdot m \cdot k)$.
- **100% Client-Side Privacy:**
  - All tokenization and hashing run locally inside the browser. No data is sent or stored on any server.
- **Scholarly Review Notice:**
  - Prominent notices reminding users that similarity scores are indicators for human pedagogical review, not proof of plagiarism.

---

## 🧮 Mathematical Foundations

### 1. Polynomial Hash Formula
For a shingle of $k$ consecutive word tokens $(w_0, w_1, \dots, w_{k-1})$ with token IDs $v_j = \text{hashWord}(w_j)$, the initial hash is:

$$H_0 = \left( \sum_{j=0}^{k-1} v_j \cdot b^{k-1-j} \right) \pmod M$$

### 2. $O(1)$ Rolling Shift
When sliding the window from shingle $i$ to shingle $i+1$, the outgoing token $v_i$ is evicted and the incoming token $v_{i+k}$ is incorporated:

$$H_{i+1} = \left( (H_i - v_i \cdot b^{k-1}) \cdot b + v_{i+k} \right) \pmod M$$

### 3. Parameters Chosen
- **Base ($b$):** $31,337$ (coprime to word token space, distributes hashes uniformly).
- **Modulus ($M$):** $2^{61} - 1 = 2,305,843,009,213,693,951$ (a Mersenne prime, fits in 64-bit integer space, eliminating hash collisions in practice).

---

## ⏱️ Computational Complexity

| Phase | Time Complexity | Space Complexity | Notes |
|---|---|---|---|
| **Text Tokenization** | $O(n + m)$ | $O(n + m)$ | Regex word boundary scanning |
| **Initial Hash Calculation** | $O(k)$ | $O(1)$ | Done once per document |
| **Source Index Construction** | $O(n)$ average | $O(n)$ | $O(1)$ rolling hash per window into Hash Map |
| **Checked Text Scanning** | $O(m)$ average | $O(1)$ | $O(1)$ rolling hash + $O(1)$ hash map lookup |
| **Collision Verification** | $O(k \cdot c)$ | $O(1)$ | $c$ = number of hash matches |
| **Total System Performance** | **$O(n + m)$ average** | **$O(n)$** | Highly scalable to long texts |

*Worst-case time complexity:* $O(n \cdot m)$ if catastrophic hash collisions occur, which is virtually impossible given the large prime modulus $M = 2^{61}-1$.

---

## 📂 Project Structure

```
plagiarism-detector-rabin-karp/
├── index.html       # Primary responsive application markup
├── style.css        # Academic aesthetic, light/dark themes, responsive layout
├── app.js           # Full Rabin-Karp engine, hash map indexer, visualizer & UI
└── README.md        # Comprehensive documentation and algorithmic reference
```

---

## 💻 How to Run

1. Simply open `index.html` in any modern web browser (Chrome, Edge, Firefox, Safari).
2. No Node.js, Python, or build step is required—the application is completely self-contained and operates client-side.
3. To view or serve locally using a static server:
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Or using npx serve
   npx serve .
   ```
   Then open `http://localhost:8000` in your browser.

---

## 📚 Academic References

1. **Rabin, M. O., & Karp, R. M. (1987).** *Efficient randomized pattern-matching algorithms.* IBM Journal of Research and Development, 31(2), 249–260.
2. **Schleimer, S., Wilkerson, D. S., & Aiken, A. (2003).** *Winnowing: Local algorithms for document fingerprinting.* In Proceedings of the 2003 ACM SIGMOD International Conference on Management of Data (pp. 76–85).
3. **Manning, C. D., Raghavan, P., & Schütze, H. (2008).** *Introduction to Information Retrieval.* Cambridge University Press.
