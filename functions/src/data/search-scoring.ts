export interface ScorableItem {
  name: string
  description: string
  tags?: string[]
  searchIndex?: string
  rating?: number
  bookingCount?: number
}

/**
 * Compute the Levenshtein (edit) distance between two strings.
 * Uses the classic dynamic-programming matrix approach — O(m*n).
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length

  // Fast-path: one string is empty
  if (m === 0) return n
  if (n === 0) return m

  // Single-row DP to save memory
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      )
    }
    // Swap rows
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev[n]
}

/**
 * Compute a dynamic threshold based on query length:
 *  - queries <= 4 chars: threshold 1
 *  - queries <= 7 chars: threshold 2
 *  - longer queries:     threshold 3
 */
function fuzzyThreshold(queryLength: number): number {
  if (queryLength <= 4) return 1
  if (queryLength <= 7) return 2
  return 3
}

/**
 * Check whether `query` fuzzy-matches against `target`.
 * Returns true for an exact substring match (fast path) OR when any
 * word in `target` has Levenshtein distance <= the dynamic threshold.
 */
export function fuzzyMatch(query: string, target: string, threshold?: number): boolean {
  // Fast path: exact substring match
  if (target.includes(query)) return true

  const t = threshold ?? fuzzyThreshold(query.length)
  const words = target.split(/\s+/)

  return words.some((word) => levenshteinDistance(query, word) <= t)
}

export function computeRelevanceScore(query: string, item: ScorableItem): number {
  if (!query.trim()) return 0

  const q = query.toLowerCase().trim()
  const name = item.name.toLowerCase()
  const description = item.description.toLowerCase()
  const tags = (item.tags ?? []).map((t) => t.toLowerCase())
  const searchIndex = (item.searchIndex ?? '').toLowerCase()

  let score = 0

  // --- Name scoring (exact > contains > fuzzy) ---
  if (name === q) {
    score += 100
  } else if (name.includes(q)) {
    score += 50
  } else if (fuzzyMatch(q, name)) {
    score += 40
  }

  // --- Tag scoring (exact > fuzzy) ---
  if (tags.some((t) => t.includes(q))) {
    score += 30
  } else if (tags.some((t) => fuzzyMatch(q, t))) {
    score += 15
  }

  // --- Search index scoring (exact > fuzzy) ---
  if (searchIndex.includes(q)) {
    score += 20
  } else if (fuzzyMatch(q, searchIndex)) {
    score += 10
  }

  // --- Description scoring (exact > fuzzy) ---
  if (description.includes(q)) {
    score += 10
  } else if (fuzzyMatch(q, description)) {
    score += 5
  }

  // Rating bonus: +(rating * 5)
  if (item.rating) {
    score += item.rating * 5
  }

  // Booking count bonus (capped at 50)
  if (item.bookingCount) {
    score += Math.min(item.bookingCount * 0.1, 50)
  }

  return score
}
