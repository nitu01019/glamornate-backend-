/**
 * Firestore Security Rules Tests for Glamornate
 *
 * These tests validate the Firestore security rules defined in firestore.rules.
 * They require the Firebase Firestore emulator to be running on localhost:8080.
 *
 * Start the emulator before running:
 *   firebase emulators:start --only firestore
 *
 * If the emulator is not running, all tests gracefully skip.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PROJECT_ID = 'demo-glamornate-rules-test'
const FIRESTORE_HOST = '127.0.0.1'
const FIRESTORE_PORT = 8080

const RULES_PATH = path.resolve(__dirname, '../../../firestore.rules')

// ---------------------------------------------------------------------------
// Test UIDs and constants
// ---------------------------------------------------------------------------
const ALICE_UID = 'alice-uid'
const BOB_UID = 'bob-uid'
const ADMIN_UID = 'admin-uid'
const SPA_OWNER_UID = 'spa-owner-uid'
const SPA_OWNER_2_UID = 'spa-owner-2-uid'
const SPA_STAFF_UID = 'spa-staff-uid'
const CUSTOMER_UID = 'customer-uid'

const SPA_ID = 'spa-001'
const SPA_ID_2 = 'spa-002'
const BOOKING_ID = 'booking-001'
const NOTIFICATION_ID = 'notif-001'
const TRANSACTION_ID = 'txn-001'
const PAYOUT_ID = 'payout-001'
const WALLET_ID = 'wallet-001'

// ---------------------------------------------------------------------------
// Bootstrap: try to connect to emulator, skip all tests if unavailable
// ---------------------------------------------------------------------------
let testEnv: RulesTestEnvironment | null = null
let emulatorAvailable = false

/**
 * Seed user documents so that helper functions in the rules
 * (getRole, isActiveUser, getUserSpaId, etc.) can resolve.
 */
async function seedUserDocuments(): Promise<void> {
  if (!testEnv) return

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()

    // Admin user
    await db.doc(`users/${ADMIN_UID}`).set({
      email: 'admin@glamornate.com',
      role: 'admin',
      isActive: true,
      profile: { name: 'Admin User' },
    })

    // Customer users
    await db.doc(`users/${ALICE_UID}`).set({
      email: 'alice@example.com',
      role: 'customer',
      isActive: true,
      profile: { name: 'Alice' },
    })

    await db.doc(`users/${BOB_UID}`).set({
      email: 'bob@example.com',
      role: 'customer',
      isActive: true,
      profile: { name: 'Bob' },
    })

    await db.doc(`users/${CUSTOMER_UID}`).set({
      email: 'customer@example.com',
      role: 'customer',
      isActive: true,
      profile: { name: 'Customer' },
    })

    // Spa owner linked to SPA_ID
    await db.doc(`users/${SPA_OWNER_UID}`).set({
      email: 'owner@spa.com',
      role: 'spa_owner',
      isActive: true,
      profile: { name: 'Spa Owner' },
      spaData: { spaId: SPA_ID },
    })

    // Second spa owner linked to SPA_ID_2
    await db.doc(`users/${SPA_OWNER_2_UID}`).set({
      email: 'owner2@spa.com',
      role: 'spa_owner',
      isActive: true,
      profile: { name: 'Spa Owner 2' },
      spaData: { spaId: SPA_ID_2 },
    })

    // Spa staff linked to SPA_ID
    await db.doc(`users/${SPA_STAFF_UID}`).set({
      email: 'staff@spa.com',
      role: 'spa_staff',
      isActive: true,
      profile: { name: 'Spa Staff' },
      spaData: { spaId: SPA_ID },
    })

    // Spa document
    await db.doc(`spas/${SPA_ID}`).set({
      name: 'Luxe Spa',
      ownerId: SPA_OWNER_UID,
      status: 'active',
    })

    await db.doc(`spas/${SPA_ID_2}`).set({
      name: 'Zen Spa',
      ownerId: SPA_OWNER_2_UID,
      status: 'active',
    })

    // Booking owned by Alice at SPA_ID
    await db.doc(`bookings/${BOOKING_ID}`).set({
      userId: ALICE_UID,
      spaId: SPA_ID,
      bookingStatus: 'confirmed',
    })

    // Notification for Alice
    await db.doc(`notifications/${NOTIFICATION_ID}`).set({
      userId: ALICE_UID,
      message: 'Your booking is confirmed',
      isRead: false,
    })

    // Transaction for Alice at SPA_ID
    await db.doc(`transactions/${TRANSACTION_ID}`).set({
      userId: ALICE_UID,
      spaId: SPA_ID,
      amount: 500,
      currency: 'INR',
    })

    // Payout for SPA_ID
    await db.doc(`payouts/${PAYOUT_ID}`).set({
      spaId: SPA_ID,
      amount: 400,
      currency: 'INR',
    })

    // Wallet for Alice
    await db.doc(`wallets/${WALLET_ID}`).set({
      userId: ALICE_UID,
      balance: 100,
    })
  })
}

// ---------------------------------------------------------------------------
// Attempt to initialize test environment
// ---------------------------------------------------------------------------
await (async () => {
  try {
    const rulesContent = fs.readFileSync(RULES_PATH, 'utf8')

    // Try synchronous connectivity check first -- if the emulator is not up
    // initializeTestEnvironment will throw.
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: rulesContent,
        host: FIRESTORE_HOST,
        port: FIRESTORE_PORT,
      },
    })
    emulatorAvailable = true
  } catch {
    emulatorAvailable = false
  }
})()

// ---------------------------------------------------------------------------
// Conditional test runner -- skip gracefully when emulator is not running
// ---------------------------------------------------------------------------
const describeWithEmulator = emulatorAvailable ? describe : describe.skip

describeWithEmulator('Firestore Security Rules', () => {
  beforeAll(async () => {
    await seedUserDocuments()
  })

  afterEach(async () => {
    // Re-seed after each test to restore known state
    // (some tests may modify data)
    await seedUserDocuments()
  })

  afterAll(async () => {
    if (testEnv) {
      await testEnv.clearFirestore()
      await testEnv.cleanup()
    }
  })

  // =========================================================================
  // Users Collection
  // =========================================================================
  describe('Users collection (/users/{userId})', () => {
    it('authenticated user can read their own profile', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`users/${ALICE_UID}`).get())
    })

    it('user cannot read another user profile', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(db.doc(`users/${BOB_UID}`).get())
    })

    it('admin can read any user profile', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(db.doc(`users/${ALICE_UID}`).get())
      await assertSucceeds(db.doc(`users/${BOB_UID}`).get())
      await assertSucceeds(db.doc(`users/${SPA_OWNER_UID}`).get())
    })

    it('user can update their own profile (allowed fields)', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc(`users/${ALICE_UID}`).update({
          profile: { name: 'Alice Updated' },
          updatedAt: new Date().toISOString(),
        })
      )
    })

    it('user cannot update another user profile', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(
        db.doc(`users/${BOB_UID}`).update({
          profile: { name: 'Hacked' },
        })
      )
    })

    it('user cannot update restricted fields (e.g., role)', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(
        db.doc(`users/${ALICE_UID}`).update({
          role: 'admin',
        })
      )
    })

    it('admin can update any user profile', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(
        db.doc(`users/${ALICE_UID}`).update({
          profile: { name: 'Alice by Admin' },
        })
      )
    })

    it('unauthenticated user cannot read any profile', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      const db = unauthed.firestore()
      await assertFails(db.doc(`users/${ALICE_UID}`).get())
    })

    it('user can delete their own profile', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`users/${ALICE_UID}`).delete())
    })

    it('user cannot delete another user profile', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(db.doc(`users/${BOB_UID}`).delete())
    })
  })

  // =========================================================================
  // User Favorites Subcollection
  // =========================================================================
  describe('User favorites subcollection (/users/{userId}/favorites/{id})', () => {
    it('user can read their own favorites', async () => {
      // Seed a favorite
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`users/${ALICE_UID}/favorites/fav1`).set({
          spaId: SPA_ID,
          addedAt: new Date().toISOString(),
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`users/${ALICE_UID}/favorites/fav1`).get())
    })

    it('user cannot read another user favorites', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`users/${BOB_UID}/favorites/fav1`).get())
    })

    it('user can write to their own favorites', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`users/${ALICE_UID}/favorites/fav2`).set({
          spaId: SPA_ID_2,
          addedAt: new Date().toISOString(),
        })
      )
    })

    it('user cannot write to another user favorites', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`users/${BOB_UID}/favorites/fav2`).set({
          spaId: SPA_ID,
        })
      )
    })
  })

  // =========================================================================
  // Spas Collection
  // =========================================================================
  describe('Spas collection (/spas/{spaId})', () => {
    it('active authenticated user can read spas', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`spas/${SPA_ID}`).get())
    })

    it('unauthenticated user cannot read spas', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(unauthed.firestore().doc(`spas/${SPA_ID}`).get())
    })

    it('spa_owner can create a spa with ownerId === auth.uid', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(
        db.doc('spas/new-spa').set({
          name: 'New Spa',
          ownerId: SPA_OWNER_UID,
          status: 'pending',
        })
      )
    })

    it('spa_owner cannot create a spa with ownerId !== auth.uid', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertFails(
        db.doc('spas/stolen-spa').set({
          name: 'Stolen Spa',
          ownerId: 'someone-else',
          status: 'pending',
        })
      )
    })

    it('customer cannot create a spa', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(
        db.doc('spas/bad-spa').set({
          name: 'Bad Spa',
          ownerId: ALICE_UID,
          status: 'pending',
        })
      )
    })

    it('spa owner can update their own spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(
        db.doc(`spas/${SPA_ID}`).update({
          name: 'Luxe Spa Renamed',
        })
      )
    })

    it('spa owner cannot update another owner spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertFails(
        db.doc(`spas/${SPA_ID_2}`).update({
          name: 'Hijacked Spa',
        })
      )
    })

    it('admin can update any spa', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(
        db.doc(`spas/${SPA_ID}`).update({
          name: 'Admin Renamed Spa',
        })
      )
    })

    it('spa owner can delete their own spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(db.doc(`spas/${SPA_ID}`).delete())
    })

    it('spa owner cannot delete another owner spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertFails(db.doc(`spas/${SPA_ID_2}`).delete())
    })
  })

  // =========================================================================
  // Spa Services Subcollection
  // =========================================================================
  describe('Spa services subcollection (/spas/{spaId}/services/{serviceId})', () => {
    it('active user can read spa services', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`spas/${SPA_ID}/services/svc1`).set({
          name: 'Swedish Massage',
          price: 500,
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`spas/${SPA_ID}/services/svc1`).get())
    })

    it('spa owner can create service in their spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertSucceeds(
        owner.firestore().doc(`spas/${SPA_ID}/services/svc-new`).set({
          name: 'Deep Tissue',
          price: 800,
        })
      )
    })

    it('spa owner cannot create service in another spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc(`spas/${SPA_ID_2}/services/svc-bad`).set({
          name: 'Injection Service',
          price: 100,
        })
      )
    })

    it('customer cannot create spa services', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`spas/${SPA_ID}/services/svc-bad`).set({
          name: 'Fake Service',
          price: 100,
        })
      )
    })
  })

  // =========================================================================
  // Bookings Collection
  // =========================================================================
  describe('Bookings collection (/bookings/{bookingId})', () => {
    it('user can read their own bookings', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('user cannot read other users bookings', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      const db = bob.firestore()
      await assertFails(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('spa owner can read bookings for their spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('spa staff can read bookings for their spa', async () => {
      const staff = testEnv!.authenticatedContext(SPA_STAFF_UID)
      const db = staff.firestore()
      await assertSucceeds(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('different spa owner cannot read bookings for another spa', async () => {
      const owner2 = testEnv!.authenticatedContext(SPA_OWNER_2_UID)
      const db = owner2.firestore()
      await assertFails(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('admin can read all bookings', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(db.doc(`bookings/${BOOKING_ID}`).get())
    })

    it('authenticated user can create a booking with userId === auth.uid', async () => {
      // Phase 1 Stripe removal (2026-05-02): bookingStatus MUST be 'confirmed'
      // on create — there is no 'draft' / 'payment_pending' phase any more.
      // Allowlisted keys must match firestore.rules L233-244 exactly.
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc('bookings/booking-new').set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          serviceIds: ['svc-1'],
          slot: { start: '2026-05-10T10:00:00Z', end: '2026-05-10T11:00:00Z' },
          bookingStatus: 'confirmed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      )
    })

    it('user cannot create a booking for another user', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(
        db.doc('bookings/booking-fake').set({
          userId: BOB_UID,
          spaId: SPA_ID,
          status: 'draft',
          date: '2026-04-15',
        })
      )
    })

    it('unauthenticated user cannot create bookings', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(
        unauthed.firestore().doc('bookings/booking-anon').set({
          userId: 'anon',
          spaId: SPA_ID,
          status: 'draft',
        })
      )
    })

    it('booking owner can update their booking', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc(`bookings/${BOOKING_ID}`).update({
          notes: 'Updated notes',
        })
      )
    })

    it('spa owner can update bookings for their spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(
        db.doc(`bookings/${BOOKING_ID}`).update({
          bookingStatus: 'cancelled',
        })
      )
    })

    it('only admin can delete bookings', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`bookings/${BOOKING_ID}`).delete())

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(admin.firestore().doc(`bookings/${BOOKING_ID}`).delete())
    })
  })

  // =========================================================================
  // Notifications Collection
  // =========================================================================
  describe('Notifications collection (/notifications/{notificationId})', () => {
    it('user can read their own notifications', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`notifications/${NOTIFICATION_ID}`).get())
    })

    it('user cannot read another user notifications', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      const db = bob.firestore()
      await assertFails(db.doc(`notifications/${NOTIFICATION_ID}`).get())
    })

    it('admin can read any notification', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(db.doc(`notifications/${NOTIFICATION_ID}`).get())
    })

    it('user can update their own notifications (mark as read)', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc(`notifications/${NOTIFICATION_ID}`).update({
          readAt: new Date().toISOString(),
        })
      )
    })

    it('user cannot update another user notifications', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      const db = bob.firestore()
      await assertFails(
        db.doc(`notifications/${NOTIFICATION_ID}`).update({
          isRead: true,
        })
      )
    })

    it('user CANNOT create notifications (only Cloud Functions)', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(
        db.doc('notifications/notif-new').set({
          userId: ALICE_UID,
          message: 'Self-created notification',
          isRead: false,
        })
      )
    })

    it('admin CANNOT create notifications either', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertFails(
        db.doc('notifications/notif-admin').set({
          userId: ADMIN_UID,
          message: 'Admin notification',
          isRead: false,
        })
      )
    })

    it('user CANNOT delete notifications', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(db.doc(`notifications/${NOTIFICATION_ID}`).delete())
    })

    it('admin CANNOT delete notifications either', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertFails(db.doc(`notifications/${NOTIFICATION_ID}`).delete())
    })
  })

  // =========================================================================
  // Transactions Collection — REMOVED in Phase 1 Stripe removal (2026-05-02).
  // The `match /transactions/{transactionId}` rule block was deleted from
  // firestore.rules. Residual docs (if any) fall through to the default
  // deny-all. Pay-at-spa has no online-payment ledger, so there's nothing
  // to test here. This describe block was deleted alongside the rules.
  // =========================================================================
  describe('Transactions collection (removed; default-deny)', () => {
    it('all client access is denied (collection has no rules)', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      // Read denied (no matching allow)
      await assertFails(alice.firestore().doc(`transactions/${TRANSACTION_ID}`).get())
      // Write denied
      await assertFails(
        alice.firestore().doc('transactions/txn-new').set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          amount: 9999,
        })
      )
    })
  })

  // =========================================================================
  // Payouts Collection (sensitive -- write: false)
  // =========================================================================
  describe('Payouts collection (/payouts/{payoutId})', () => {
    it('spa owner can read their own spa payouts', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      const db = owner.firestore()
      await assertSucceeds(db.doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('different spa owner cannot read another spa payouts', async () => {
      const owner2 = testEnv!.authenticatedContext(SPA_OWNER_2_UID)
      const db = owner2.firestore()
      await assertFails(db.doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('admin can read any payout', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(db.doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('customer cannot read payouts', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertFails(db.doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('no client can write to payouts', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc('payouts/payout-new').set({
          spaId: SPA_ID,
          amount: 1000,
        })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc('payouts/payout-admin').set({
          spaId: SPA_ID,
          amount: 5000,
        })
      )
    })
  })

  // =========================================================================
  // Wallets Collection (sensitive -- write: false)
  // =========================================================================
  describe('Wallets collection (/wallets/{walletId})', () => {
    it('wallet owner can read their wallet', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(db.doc(`wallets/${WALLET_ID}`).get())
    })

    it('another user cannot read someone else wallet', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      const db = bob.firestore()
      await assertFails(db.doc(`wallets/${WALLET_ID}`).get())
    })

    it('admin can read any wallet', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      const db = admin.firestore()
      await assertSucceeds(db.doc(`wallets/${WALLET_ID}`).get())
    })

    it('no client can write to wallets', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`wallets/${WALLET_ID}`).update({ balance: 9999 })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc('wallets/wallet-new').set({
          userId: ALICE_UID,
          balance: 0,
        })
      )
    })
  })

  // =========================================================================
  // Reviews Collection
  // =========================================================================
  describe('Reviews collection (/reviews/{reviewId})', () => {
    const REVIEW_ID = 'review-001'

    it('active user can read reviews', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`reviews/${REVIEW_ID}`).set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          rating: 5,
          text: 'Great experience!',
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`reviews/${REVIEW_ID}`).get())
    })

    it('authenticated user can create a review', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertSucceeds(
        bob.firestore().doc('reviews/review-new').set({
          userId: BOB_UID,
          spaId: SPA_ID,
          rating: 4,
          text: 'Nice place',
        })
      )
    })

    it('review owner can update their review', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`reviews/${REVIEW_ID}`).set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          rating: 5,
          text: 'Great!',
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`reviews/${REVIEW_ID}`).update({ rating: 4 })
      )
    })

    it('another user cannot update someone else review', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertFails(
        bob.firestore().doc(`reviews/${REVIEW_ID}`).update({ rating: 1 })
      )
    })

    it('review owner can delete their review', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`reviews/${REVIEW_ID}`).delete())
    })
  })

  // =========================================================================
  // Availability Collection (read-only for clients)
  // =========================================================================
  describe('Availability collection (/availability/{compositeId})', () => {
    it('active user can read availability', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('availability/spa001_2026-04-10').set({
          spaId: SPA_ID,
          date: '2026-04-10',
          slots: [],
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc('availability/spa001_2026-04-10').get())
    })

    it('no client can write to availability', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc('availability/spa001_2026-04-11').set({
          spaId: SPA_ID,
          date: '2026-04-11',
          slots: [],
        })
      )
    })
  })

  // =========================================================================
  // Vouchers Collection (admin-only write)
  // =========================================================================
  describe('Vouchers collection (/vouchers/{voucherId})', () => {
    it('active user can read vouchers', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('vouchers/voucher-001').set({
          code: 'SUMMER20',
          discount: 20,
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc('vouchers/voucher-001').get())
    })

    it('only admin can create vouchers', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc('vouchers/voucher-bad').set({ code: 'FREE', discount: 100 })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc('vouchers/voucher-admin').set({ code: 'ADMIN10', discount: 10 })
      )
    })

    it('customer cannot delete vouchers', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc('vouchers/voucher-001').delete())
    })
  })

  // =========================================================================
  // Services Collection (global catalog -- admin-only write)
  // =========================================================================
  describe('Global services collection (/services/{serviceId})', () => {
    it('active user can read global services', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('services/svc-global-1').set({
          name: 'Swedish Massage',
          category: 'massage',
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc('services/svc-global-1').get())
    })

    it('only admin can create global services', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc('services/svc-bad').set({ name: 'Fake', category: 'body' })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc('services/svc-new').set({ name: 'Hot Stone', category: 'massage' })
      )
    })

    it('only admin can update global services', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('services/svc-updatable').set({
          name: 'Old Service',
          category: 'wellness',
        })
      })

      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc('services/svc-updatable').update({ name: 'Hacked' })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc('services/svc-updatable').update({ name: 'Updated Service' })
      )
    })
  })

  // =========================================================================
  // Analytics Collection (admin-only read, Cloud Functions-only write)
  // =========================================================================
  describe('Analytics collection (/analytics/{compositeId})', () => {
    it('admin can read analytics', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('analytics/2026-04').set({ views: 100 })
      })

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(admin.firestore().doc('analytics/2026-04').get())
    })

    it('non-admin cannot read analytics', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc('analytics/2026-04').get())
    })

    it('no client can write to analytics', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc('analytics/2026-05').set({ views: 0 })
      )
    })
  })

  // =========================================================================
  // Audit Logs Collection (admin-only read, Cloud Functions-only write)
  // =========================================================================
  describe('Audit logs collection (/audit_logs/{logId})', () => {
    it('admin can read audit logs', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('audit_logs/log-001').set({
          action: 'user.created',
          timestamp: new Date().toISOString(),
        })
      })

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(admin.firestore().doc('audit_logs/log-001').get())
    })

    it('non-admin cannot read audit logs', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc('audit_logs/log-001').get())
    })

    it('no client can write to audit logs', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc('audit_logs/log-new').set({ action: 'test' })
      )
    })
  })

  // =========================================================================
  // Flags Collection (feature flags -- admin-only write)
  // =========================================================================
  describe('Flags collection (/flags/{flagId})', () => {
    it('active user can read flags', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('flags/new-ui').set({ enabled: true })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc('flags/new-ui').get())
    })

    it('only admin can write flags', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc('flags/evil-flag').set({ enabled: true })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc('flags/admin-flag').set({ enabled: false })
      )
    })
  })

  // =========================================================================
  // Chats Collection (user owns their own chat doc keyed by uid)
  // =========================================================================
  describe('Chats collection (/chats/{chatId})', () => {
    it('user can read and write their own chat', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc(`chats/${ALICE_UID}`).set({ lastMessage: 'Hello' })
      )
      await assertSucceeds(db.doc(`chats/${ALICE_UID}`).get())
    })

    it('user cannot access another user chat', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`chats/${BOB_UID}`).get())
      await assertFails(
        alice.firestore().doc(`chats/${BOB_UID}`).set({ lastMessage: 'Hacked' })
      )
    })

    it('user can read/write messages in their own chat', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`chats/${ALICE_UID}/messages/msg-001`).set({
          text: 'Hi there',
          sentAt: new Date().toISOString(),
        })
      )
      await assertSucceeds(
        alice.firestore().doc(`chats/${ALICE_UID}/messages/msg-001`).get()
      )
    })

    it('user cannot access messages in another user chat', async () => {
      // Seed a message first
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`chats/${BOB_UID}`).set({ lastMessage: 'Secret' })
        await ctx.firestore().doc(`chats/${BOB_UID}/messages/msg-001`).set({
          text: 'Private message',
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`chats/${BOB_UID}/messages/msg-001`).get())
    })
  })

  // =========================================================================
  // Carts Collection (user owns their own cart keyed by uid)
  // =========================================================================
  describe('Carts collection (/carts/{userId})', () => {
    it('user can read and write their own cart', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const db = alice.firestore()
      await assertSucceeds(
        db.doc(`carts/${ALICE_UID}`).set({ items: [{ serviceId: 'svc1', qty: 1 }] })
      )
      await assertSucceeds(db.doc(`carts/${ALICE_UID}`).get())
    })

    it('user cannot access another user cart', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`carts/${BOB_UID}`).get())
      await assertFails(
        alice.firestore().doc(`carts/${BOB_UID}`).set({ items: [] })
      )
    })

    it('unauthenticated user cannot access carts', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(unauthed.firestore().doc(`carts/${ALICE_UID}`).get())
    })

    // NEEDS_WORK §3.4 — write-only size cap (50 items max)
    it('rejects writes with > 50 items in items array', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      const oversized = Array.from({ length: 60 }, (_, i) => ({
        serviceId: `svc-${i}`,
        quantity: 1,
      }))
      await assertFails(
        alice.firestore().doc(`carts/${ALICE_UID}`).set({ items: oversized })
      )
    })

    // Grandfather clause — existing oversized docs stay readable
    it('grandfather clause: pre-existing oversized cart remains readable', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        const oversized = Array.from({ length: 100 }, (_, i) => ({
          serviceId: `svc-${i}`,
          quantity: 1,
        }))
        await ctx.firestore().doc(`carts/${ALICE_UID}`).set({ items: oversized })
      })
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`carts/${ALICE_UID}`).get())
    })
  })

  // =========================================================================
  // Support Tickets Collection
  // =========================================================================
  describe('Support tickets collection (/support_tickets/{ticketId})', () => {
    const TICKET_ID = 'ticket-001'

    it('ticket creator can read their ticket', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`support_tickets/${TICKET_ID}`).set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          subject: 'Help needed',
          status: 'open',
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(alice.firestore().doc(`support_tickets/${TICKET_ID}`).get())
    })

    it('spa owner can read tickets for their spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertSucceeds(owner.firestore().doc(`support_tickets/${TICKET_ID}`).get())
    })

    it('unrelated user cannot read the ticket', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertFails(bob.firestore().doc(`support_tickets/${TICKET_ID}`).get())
    })

    it('authenticated user can create a support ticket', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertSucceeds(
        bob.firestore().doc('support_tickets/ticket-new').set({
          userId: BOB_UID,
          subject: 'Question about booking',
          status: 'open',
        })
      )
    })

    it('only admin can update support tickets', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`support_tickets/${TICKET_ID}`).update({ status: 'resolved' })
      )

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc(`support_tickets/${TICKET_ID}`).update({ status: 'resolved' })
      )
    })

    it('only admin can delete support tickets', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(alice.firestore().doc(`support_tickets/${TICKET_ID}`).delete())

      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(admin.firestore().doc(`support_tickets/${TICKET_ID}`).delete())
    })
  })

  // =========================================================================
  // QA-M7: Addresses subcollection (/users/{userId}/addresses/{addressId})
  // Server-only writes via the addAddress / updateAddress callables.
  // =========================================================================
  describe('Addresses subcollection (/users/{userId}/addresses/{addressId})', () => {
    const ADDR_ID = 'addr-001'

    async function seedAddress(userId: string): Promise<void> {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`users/${userId}/addresses/${ADDR_ID}`).set({
          line1: '1 Infinite Loop',
          city: 'Cupertino',
          country: 'US',
        })
      })
    }

    // Read
    it('unauthenticated read is denied', async () => {
      await seedAddress(ALICE_UID)
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(
        unauthed.firestore().doc(`users/${ALICE_UID}/addresses/${ADDR_ID}`).get(),
      )
    })

    it('owner can read their own address', async () => {
      await seedAddress(ALICE_UID)
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`users/${ALICE_UID}/addresses/${ADDR_ID}`).get(),
      )
    })

    it('cross-user read is denied', async () => {
      await seedAddress(ALICE_UID)
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertFails(
        bob.firestore().doc(`users/${ALICE_UID}/addresses/${ADDR_ID}`).get(),
      )
    })

    it('admin read is denied (matches rules — addresses have no admin override)', async () => {
      // Rules: addresses subcollection read is `isOwner(userId)` only.
      // Admin is NOT granted visibility here; callables proxy admin access.
      await seedAddress(ALICE_UID)
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc(`users/${ALICE_UID}/addresses/${ADDR_ID}`).get(),
      )
    })

    // Write — all denied from client per rules (Cloud Functions only)
    it('owner cannot create an address from client', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`users/${ALICE_UID}/addresses/new-addr`).set({
          line1: 'Somewhere',
          city: 'Nowhere',
          country: 'XX',
        }),
      )
    })

    it('cross-user client write is denied', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`users/${BOB_UID}/addresses/new-addr`).set({
          line1: 'Hijacked',
          city: 'Nowhere',
          country: 'XX',
        }),
      )
    })

    it('client update is denied (callable only)', async () => {
      await seedAddress(ALICE_UID)
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`users/${ALICE_UID}/addresses/${ADDR_ID}`).update({
          line1: 'Updated',
        }),
      )
    })

    it('admin client write is denied (callable only)', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc(`users/${ALICE_UID}/addresses/addr-admin`).set({
          line1: 'Admin write',
          city: 'X',
          country: 'X',
        }),
      )
    })
  })

  // =========================================================================
  // QA-M7: Reviews — expanded coverage (unauth, cross-user, schema-invalid)
  // =========================================================================
  describe('Reviews collection (expanded QA-M7 cases)', () => {
    const REVIEW_ID = 'review-expanded'

    it('unauthenticated read is denied', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`reviews/${REVIEW_ID}`).set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          rating: 5,
        })
      })
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(unauthed.firestore().doc(`reviews/${REVIEW_ID}`).get())
    })

    it('unauthenticated create is denied', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(
        unauthed.firestore().doc('reviews/anon-review').set({
          userId: 'anon',
          spaId: SPA_ID,
          rating: 3,
        }),
      )
    })

    it('authenticated user cannot create a review attributed to another user', async () => {
      // Rules enforce `request.resource.data.userId == request.auth.uid` on create.
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc('reviews/fake-review').set({
          userId: BOB_UID, // mismatch with auth.uid
          spaId: SPA_ID,
          rating: 5,
          text: 'Fake attribution',
        }),
      )
    })

    it('admin can delete any review', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`reviews/${REVIEW_ID}`).set({
          userId: ALICE_UID,
          spaId: SPA_ID,
          rating: 5,
        })
      })
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc(`reviews/${REVIEW_ID}`).delete(),
      )
    })
  })

  // =========================================================================
  // QA-M7: Vouchers — expanded coverage (admin override + cross-user)
  // =========================================================================
  describe('Vouchers collection (expanded QA-M7 cases)', () => {
    const VOUCHER_ID = 'voucher-expanded'

    it('unauthenticated read is denied', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`vouchers/${VOUCHER_ID}`).set({
          code: 'WELCOME',
          discount: 10,
        })
      })
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(unauthed.firestore().doc(`vouchers/${VOUCHER_ID}`).get())
    })

    it('non-admin update is denied', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`vouchers/${VOUCHER_ID}`).set({
          code: 'WELCOME',
          discount: 10,
        })
      })
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc(`vouchers/${VOUCHER_ID}`).update({ discount: 99 }),
      )
    })

    it('admin override: admin can update any voucher', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`vouchers/${VOUCHER_ID}`).set({
          code: 'WELCOME',
          discount: 10,
        })
      })
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc(`vouchers/${VOUCHER_ID}`).update({ discount: 25 }),
      )
    })

    it('admin override: admin can delete a voucher', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`vouchers/${VOUCHER_ID}`).set({
          code: 'WELCOME',
          discount: 10,
        })
      })
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(
        admin.firestore().doc(`vouchers/${VOUCHER_ID}`).delete(),
      )
    })
  })

  // =========================================================================
  // QA-M7: Spa services global catalog (/spa_services/{compositeId})
  // Per-spa service overrides. compositeId = `${spaId}_${serviceId}`.
  // =========================================================================
  describe('Global spa_services collection (/spa_services/{compositeId})', () => {
    const SPA_SVC_ID = `${SPA_ID}_svc-001`
    const SPA_SVC_ID_2 = `${SPA_ID_2}_svc-002`

    async function seedSpaService(id: string, spaId: string): Promise<void> {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`spa_services/${id}`).set({
          spaId,
          name: 'Test Service',
          price: 1000,
        })
      })
    }

    it('unauthenticated read is denied', async () => {
      await seedSpaService(SPA_SVC_ID, SPA_ID)
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(
        unauthed.firestore().doc(`spa_services/${SPA_SVC_ID}`).get(),
      )
    })

    it('active authenticated user can read spa_services', async () => {
      await seedSpaService(SPA_SVC_ID, SPA_ID)
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`spa_services/${SPA_SVC_ID}`).get(),
      )
    })

    it('spa owner can create services for their own spa', async () => {
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertSucceeds(
        owner.firestore().doc(`spa_services/${SPA_ID}_svc-new`).set({
          spaId: SPA_ID,
          name: 'New Service',
          price: 1200,
        }),
      )
    })

    it('spa owner cannot create services for another spa (cross-spa denied)', async () => {
      // compositeId prefix identifies the target spa; the owner of SPA_ID
      // must not be able to write under SPA_ID_2's prefix.
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc(`spa_services/${SPA_ID_2}_svc-hijack`).set({
          spaId: SPA_ID_2,
          name: 'Hijack',
          price: 0,
        }),
      )
    })

    it('customer cannot write spa_services', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`spa_services/${SPA_ID}_svc-bad`).set({
          spaId: SPA_ID,
          name: 'Fake',
          price: 0,
        }),
      )
    })

    it('spa owner can update their own spa_services', async () => {
      await seedSpaService(SPA_SVC_ID, SPA_ID)
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertSucceeds(
        owner.firestore().doc(`spa_services/${SPA_SVC_ID}`).update({
          price: 1500,
        }),
      )
    })

    it('spa owner cannot update another spa services', async () => {
      await seedSpaService(SPA_SVC_ID_2, SPA_ID_2)
      const owner = testEnv!.authenticatedContext(SPA_OWNER_UID)
      await assertFails(
        owner.firestore().doc(`spa_services/${SPA_SVC_ID_2}`).update({
          price: 0,
        }),
      )
    })
  })

  // =========================================================================
  // QA-M7: Payouts — expanded coverage (unauth + cross-user + schema)
  // =========================================================================
  describe('Payouts collection (expanded QA-M7 cases)', () => {
    it('unauthenticated read is denied', async () => {
      const unauthed = testEnv!.unauthenticatedContext()
      await assertFails(unauthed.firestore().doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('customer cross-user read is denied', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertFails(bob.firestore().doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('spa owner of a DIFFERENT spa cannot read payout', async () => {
      const owner2 = testEnv!.authenticatedContext(SPA_OWNER_2_UID)
      await assertFails(
        owner2.firestore().doc(`payouts/${PAYOUT_ID}`).get(),
      )
    })

    it('admin bypass: admin can read any payout', async () => {
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertSucceeds(admin.firestore().doc(`payouts/${PAYOUT_ID}`).get())
    })

    it('schema-invalid write is still denied (all writes blocked)', async () => {
      // Even well-formed admin writes are blocked per the rules — payouts
      // are Cloud-Functions-only. This test documents the invariant.
      const admin = testEnv!.authenticatedContext(ADMIN_UID)
      await assertFails(
        admin.firestore().doc('payouts/payout-invalid').set({
          // intentionally missing spaId to mimic schema-invalid payload
          amount: -5,
          currency: 'INR',
        }),
      )
    })
  })

  // =========================================================================
  // User Vouchers Collection (Cloud Functions-only write)
  // =========================================================================
  describe('User vouchers collection (/user_vouchers/{compositeId})', () => {
    it('user can read their own user vouchers', async () => {
      await testEnv!.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`user_vouchers/${ALICE_UID}_voucher001`).set({
          voucherId: 'voucher-001',
          used: false,
        })
      })

      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertSucceeds(
        alice.firestore().doc(`user_vouchers/${ALICE_UID}_voucher001`).get()
      )
    })

    it('user cannot read another user vouchers', async () => {
      const bob = testEnv!.authenticatedContext(BOB_UID)
      await assertFails(
        bob.firestore().doc(`user_vouchers/${ALICE_UID}_voucher001`).get()
      )
    })

    it('no client can write to user vouchers', async () => {
      const alice = testEnv!.authenticatedContext(ALICE_UID)
      await assertFails(
        alice.firestore().doc(`user_vouchers/${ALICE_UID}_new`).set({
          voucherId: 'voucher-free',
          used: false,
        })
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Informational test that always runs to indicate emulator status
// ---------------------------------------------------------------------------
describe('Firestore Rules Test Suite Status', () => {
  it(`emulator status: ${emulatorAvailable ? 'CONNECTED' : 'NOT AVAILABLE (tests skipped)'}`, () => {
    if (!emulatorAvailable) {
      console.warn(
        '\n[WARN] Firebase Firestore emulator is not running.\n' +
        '       All security rules tests have been SKIPPED.\n' +
        '       Start the emulator with: firebase emulators:start --only firestore\n' +
        '       Then re-run: npx vitest run\n'
      )
    }
    // This test always passes -- it is informational only
    expect(true).toBe(true)
  })
})
