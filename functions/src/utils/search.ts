import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

const db = admin.firestore();

// ============================================================================
// Firestore Document Interfaces
// ============================================================================

interface SpaDocData {
  name?: string;
  shortDescription?: string;
  location?: {
    city?: string;
    state?: string;
    pincode?: string;
    geo?: { lat: number; lng: number };
  };
  categories?: string[];
  amenities?: string[];
  rating?: { overall: number; count: number };
  tier?: string;
  featuredImage?: string;
  status?: string;
  isActive?: boolean;
  [key: string]: unknown;
}

// ============================================================================
// Algolia Search Integration
// ============================================================================

interface AlgoliaClient {
  index: (name: string) => AlgoliaIndex;
}

interface AlgoliaSearchableRecord {
  objectID: string;
  [key: string]: unknown;
}

interface AlgoliaIndex {
  saveObject: (object: AlgoliaSearchableRecord, options?: Record<string, unknown>) => Promise<unknown>;
}

// Mock Algolia client (replace with actual Algolia client in production)
class MockAlgoliaClient implements AlgoliaClient {
  indexes: Map<string, AlgoliaSearchableRecord[]> = new Map();

  index(name: string): AlgoliaIndex {
    if (!this.indexes.has(name)) {
      this.indexes.set(name, []);
    }

    return {
      saveObject: async (object: AlgoliaSearchableRecord) => {
        const objects = this.indexes.get(name)!;
        const existingIndex = objects.findIndex((o) => o.objectID === object.objectID);
        if (existingIndex >= 0) {
          objects[existingIndex] = object;
        } else {
          objects.push(object);
        }
        return { objectID: object.objectID };
      },
    };
  }
}

const algoliaClient: AlgoliaClient = process.env.ALGOLIA_ADMIN_KEY
  ? require('algoliasearch')(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_ADMIN_KEY)
  : new MockAlgoliaClient();

/**
 * Index a spa in Algolia
 */
export async function indexSpa(spaId: string): Promise<void> {
  const spaDoc = await db.collection('spas').doc(spaId).get();
  if (!spaDoc.exists) return;

  const spa: SpaDocData & { id: string } = { id: spaDoc.id, ...(spaDoc.data() as SpaDocData) };

  const searchableRecord = {
    objectID: spaId,
    name: spa.name,
    description: spa.shortDescription,
    city: spa.location?.city || '',
    state: spa.location?.state || '',
    pincode: spa.location?.pincode || '',
    location: {
      lat: spa.location?.geo?.lat || 0,
      lng: spa.location?.geo?.lng || 0,
    },
    categories: spa.categories || [],
    amenities: spa.amenities || [],
    rating: spa.rating?.overall || 0,
    reviewCount: spa.rating?.count || 0,
    tier: spa.tier,
    priceRange: '\u20b9\u20b9\u20b9', // Can be calculated from services
    featuredImage: spa.featuredImage,
    status: spa.status,
    isActive: spa.isActive,
    _geoloc: {
      lat: spa.location?.geo?.lat || 0,
      lng: spa.location?.geo?.lng || 0,
    },
  };

  const index = algoliaClient.index('spas');
  await index.saveObject(searchableRecord);

  functions.logger.info(`Spa indexed`, { spaId });
}
