import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

const db = admin.firestore();

// ============================================================================
// Common Database Operations
// ============================================================================

/**
 * Execute a transaction with retry logic
 */
export async function executeTransaction<T>(
  transactionFn: (transaction: admin.firestore.Transaction) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await db.runTransaction(async (transaction) => {
        return await transactionFn(transaction);
      });
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Only retry on transaction conflicts
      const code = (error as { code?: string }).code;
      if (code === 'aborted' && attempt < maxRetries - 1) {
        await delay(100 + (attempt * 100)); // Exponential backoff
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Transaction failed');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Batch update documents
 */
export async function batchUpdate(
  updates: Array<{
    ref: admin.firestore.DocumentReference;
    data: Record<string, unknown>;
  }>,
  options?: { allOrNothing?: boolean }
): Promise<void> {
  const MAX_BATCH_SIZE = 500;

  for (let i = 0; i < updates.length; i += MAX_BATCH_SIZE) {
    const batch = db.batch();
    const batchUpdates = updates.slice(i, i + MAX_BATCH_SIZE);

    batchUpdates.forEach(({ ref, data }) => {
      batch.update(ref, data);
    });

    await batch.commit();
  }
}

/**
 * Batch create documents
 */
export async function batchCreate(
  creates: Array<{
    collection: string;
    data: unknown;
  }>
): Promise<string[]> {
  const MAX_BATCH_SIZE = 500;
  const docIds: string[] = [];

  for (let i = 0; i < creates.length; i += MAX_BATCH_SIZE) {
    const batch = db.batch();
    const batchCreates = creates.slice(i, i + MAX_BATCH_SIZE);

    batchCreates.forEach(({ collection, data }) => {
      const docRef = db.collection(collection).doc();
      batch.set(docRef, data);
      docIds.push(docRef.id);
    });

    await batch.commit();
  }

  return docIds;
}

/**
 * Get document with cache
 */
export async function getDocumentWithCache<T>(
  collection: string,
  docId: string,
  cacheTTL = 5000 // 5 seconds
): Promise<T | null> {
  // Simple in-memory cache (consider using Redis in production)
  const cacheKey = `${collection}:${docId}`;
  const globalWithCache = global as typeof globalThis & {
    _cache?: Map<string, { data: unknown; timestamp: number }>;
  };
  const cached = globalWithCache._cache?.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < cacheTTL) {
    return cached.data as T;
  }

  const doc = await db.collection(collection).doc(docId).get();

  if (!doc.exists) {
    return null;
  }

  const data = { id: doc.id, ...doc.data() } as T;

  if (!globalWithCache._cache) {
    globalWithCache._cache = new Map();
  }
  globalWithCache._cache.set(cacheKey, { data, timestamp: Date.now() });

  return data;
}

/**
 * Query with pagination
 */
export async function queryWithPagination<T>(
  collection: string,
  options: {
    where?: Array<{ field: string; op: string; value: unknown }>;
    orderBy?: { field: string; direction: 'asc' | 'desc' };
    limit?: number;
    startAfter?: string;
  }
): Promise<{
  data: T[];
  lastDocId: string | null;
  hasMore: boolean;
}> {
  let query: admin.firestore.Query = db.collection(collection);

  // Apply filters
  options.where?.forEach(({ field, op, value }) => {
    query = query.where(field, op as admin.firestore.WhereFilterOp, value);
  });

  // Apply ordering
  if (options.orderBy) {
    query = query.orderBy(options.orderBy.field, options.orderBy.direction);
  }

  // Apply limit
  if (options.limit) {
    query = query.limit(options.limit + 1); // Get one extra to check hasMore
  }

  // Apply pagination cursor
  if (options.startAfter) {
    const startAfterDoc = await db.collection(collection).doc(options.startAfter).get();
    if (startAfterDoc.exists) {
      query = query.startAfter(startAfterDoc);
    }
  }

  const snapshot = await query.get();
  const docs = snapshot.docs;

  const hasMore = docs.length > (options.limit || 10);
  const data = hasMore ? docs.slice(0, -1) : docs;

  return {
    data: data.map(doc => ({ id: doc.id, ...doc.data() }) as unknown as T),
    lastDocId: data.length > 0 ? data[data.length - 1].id : null,
    hasMore,
  };
}

/**
 * Counter with atomic increment
 */
export async function incrementCounter(
  counterPath: string,
  amount = 1
): Promise<number> {
  const counterRef = db.doc(counterPath);

  await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);

    if (!counterDoc.exists) {
      transaction.set(counterRef, { count: amount });
    } else {
      const current = counterDoc.data()?.count || 0;
      transaction.set(counterRef, { count: current + amount }, { merge: true });
    }
  });

  const updated = await counterRef.get();
  return updated.data()?.count || 0;
}

/**
 * Atomic counter for IDs
 */
export async function getNextId(prefix: string): Promise<string> {
  const counterRef = db.collection('counters').doc(prefix);

  const result = await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);

    let nextId = 1;

    if (counterDoc.exists) {
      const current = counterDoc.data()?.lastId || 0;
      nextId = current + 1;
    }

    transaction.set(counterRef, {
      lastId: nextId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return nextId;
  });

  const paddedId = String(result).padStart(8, '0');
  return `${prefix}${paddedId}`;
}

/**
 * Soft delete document
 */
export async function softDelete(
  collection: string,
  docId: string,
  userId: string
): Promise<void> {
  const docRef = db.collection(collection).doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new functions.https.HttpsError('not-found', 'Document not found');
  }

  await docRef.update({
    isActive: false,
    deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    deletedBy: userId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Restore soft deleted document
 */
export async function restoreDocument(
  collection: string,
  docId: string,
  userId: string
): Promise<void> {
  const docRef = db.collection(collection).doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new functions.https.HttpsError('not-found', 'Document not found');
  }

  await docRef.update({
    isActive: true,
    deletedAt: null,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    restoredBy: userId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Archive old documents
 */
export async function archiveOldDocuments(
  collection: string,
  dateField: string,
  cutoffDate: Date
): Promise<number> {
  const query = db.collection(collection)
    .where(dateField, '<', admin.firestore.Timestamp.fromDate(cutoffDate))
    .where('isActive', '==', true)
    .limit(500);

  const snapshot = await query.get();

  if (snapshot.empty) {
    return 0;
  }

  const batch = db.batch();

  snapshot.docs.forEach(doc => {
    // Copy to archive collection
    const archiveRef = db.collection(`${collection}_archive`).doc(doc.id);
    batch.set(archiveRef, doc.data());

    // Mark original as archived
    batch.update(doc.ref, {
      isArchived: true,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
  return snapshot.size;
}

/**
 * Paginated cursor-based aggregator. Walks the collection in {@link PAGE_SIZE}
 * chunks via `startAfter`, accumulating into an in-memory map. Use this only
 * when the result map is bounded (e.g., aggregating into <= 1000 distinct keys);
 * unbounded keys will still OOM regardless of pagination.
 *
 * For >100k-document collections, prefer a scheduled job that writes a
 * pre-aggregated summary doc instead.
 */
export async function aggregateByField<T>(
  collection: string,
  groupBy: string,
  aggregations: Record<string, 'sum' | 'count' | 'avg'>,
  filters?: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const PAGE_SIZE = 500;
  const groups: Map<string, Array<Record<string, unknown>>> = new Map();
  let lastDoc: admin.firestore.QueryDocumentSnapshot | undefined;

  while (true) {
    let q: admin.firestore.Query = db
      .collection(collection)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data();

      // Apply filters
      if (filters) {
        let skip = false;
        for (const [key, value] of Object.entries(filters)) {
          if (data[key] !== value) {
            skip = true;
            break;
          }
        }
        if (skip) continue;
      }

      const groupKey = String(data[groupBy] || 'unknown');

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }

      groups.get(groupKey)!.push(data);
    }

    if (snap.size < PAGE_SIZE) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  const results: Array<Record<string, unknown>> = [];

  for (const [key, items] of groups.entries()) {
    const result: Record<string, unknown> = { [groupBy]: key };

    for (const [aggField, aggType] of Object.entries(aggregations)) {
      const values = items
        .map((item: Record<string, unknown>) => item[aggField])
        .filter((v): v is number => typeof v === 'number');

      switch (aggType) {
        case 'count':
          result[aggField] = values.length;
          break;
        case 'sum':
          result[aggField] = values.reduce((sum, v) => sum + (v || 0), 0);
          break;
        case 'avg':
          result[aggField] = values.length > 0
            ? values.reduce((sum, v) => sum + (v || 0), 0) / values.length
            : 0;
          break;
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Export collection data (for backup/migration)
 */
export async function exportCollection(
  collection: string,
  limit?: number
): Promise<unknown[]> {
  let query = db.collection(collection)?.orderBy('createdAt', 'desc');

  if (limit) {
    query = query?.limit(limit);
  }

  if (!query) {
    query = db.collection(collection);
  }

  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * Import collection data (for migration)
 */
export async function importCollection(
  collection: string,
  data: unknown[],
  options?: { overwrite?: boolean; batchSize?: number }
): Promise<{ imported: number; skipped: number; errors: Array<{ id: string; error: string }> }> {
  const batchSize = options?.batchSize || 100;
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (let i = 0; i < data.length; i += batchSize) {
    const batch = db.batch();
    const batchData = data.slice(i, i + batchSize);
    const { __id, ...item } = batchData[0] as Record<string, unknown> & { __id?: string; id?: string };

    if (options?.overwrite) {
      const docRef = db.collection(collection).doc((__id || (batchData[0] as Record<string, unknown>).id) as string);
      batch.set(docRef, item, { merge: true });
    } else {
      const docRef = db.collection(collection).doc();
      batch.set(docRef, item);
    }

    try {
      await batch.commit();
      imported += batchData.length;
    } catch (error: unknown) {
      errors.push({ id: __id || 'unknown', error: String(error) });
    }
  }

  return { imported, skipped, errors };
}

/**
 * Clean up expired data
 */
export async function cleanupExpiredData(): Promise<{
  availability: number;
  realtimeUpdates: number;
  notifications: number;
}> {
  const now = admin.firestore.Timestamp.now();

  const [availabilitySnap, updatesSnap, notificationsSnap] = await Promise.all([
    db.collection('availability').where('expiresAt', '<=', now).limit(500).get(),
    db.collection('realtime_updates').where('expiresAt', '<=', now).limit(500).get(),
    db.collection('notifications').where('createdAt', '<=', now).limit(1000).get(),
  ]);

  let deleted = 0;

  // Delete expired availability
  for (const doc of availabilitySnap.docs) {
    await doc.ref.delete();
    deleted++;
  }

  // Delete old realtime updates
  for (const doc of updatesSnap.docs) {
    await doc.ref.delete();
    deleted++;
  }

  // Mark old notifications as auto-read
  for (const doc of notificationsSnap.docs) {
    const createdAt = doc.data()?.createdAt?.toDate();
    if (createdAt && (Date.now() - createdAt.getTime()) > 30 * 24 * 60 * 60 * 1000) {
      await doc.ref.update({ read: true, autoRead: true });
    }
  }

  return {
    availability: availabilitySnap.size,
    realtimeUpdates: updatesSnap.size,
    notifications: notificationsSnap.size,
  };
}
