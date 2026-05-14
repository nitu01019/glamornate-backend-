import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// firebase-admin must be mocked before notifications.ts is loaded because
// it calls admin.firestore() at module-level on import.
// ---------------------------------------------------------------------------
vi.mock('firebase-admin', () => ({
  default: {
    firestore: () => ({}),
    messaging: () => ({}),
  },
  firestore: Object.assign(() => ({}), {
    FieldValue: {
      serverTimestamp: vi.fn(),
      arrayRemove: vi.fn(),
      arrayUnion: vi.fn(),
      delete: vi.fn(),
    },
    Timestamp: { now: vi.fn(), fromMillis: vi.fn() },
  }),
  messaging: vi.fn(() => ({})),
}));

vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: vi.fn(), send: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Each test gets a fresh module so the module-level `sendGridInitialised`
// flag (inside notifications.ts) is reset between runs.
// ---------------------------------------------------------------------------
describe('sendEmailNotification — M-NOTIFY restore', () => {
  let sendEmailNotification: (payload: {
    to: string;
    subject: string;
    html?: string;
    from?: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
  }) => Promise<boolean>;
  let sgSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    // Re-apply mocks after module reset
    vi.doMock('firebase-admin', () => ({
      default: { firestore: () => ({}), messaging: () => ({}) },
      firestore: Object.assign(() => ({}), {
        FieldValue: {
          serverTimestamp: vi.fn(),
          arrayRemove: vi.fn(),
          arrayUnion: vi.fn(),
          delete: vi.fn(),
        },
        Timestamp: { now: vi.fn(), fromMillis: vi.fn() },
      }),
      messaging: vi.fn(() => ({})),
    }));

    sgSend = vi.fn();
    vi.doMock('@sendgrid/mail', () => ({
      default: { setApiKey: vi.fn(), send: sgSend },
    }));

    // Set env before importing so ensureSendGrid() sees the key
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.SENDGRID_FROM_EMAIL = 'no-reply@glamornate.com';
    process.env.SENDGRID_FROM_NAME = 'Glamornate';

    const mod = await import('../notifications');
    sendEmailNotification = mod.sendEmailNotification;
  });

  it('returns true on 2xx', async () => {
    sgSend.mockResolvedValue([{ statusCode: 202 }, {}]);
    const ok = await sendEmailNotification({ to: 'a@b.com', subject: 'Test', html: '<p>Hi</p>' });
    expect(ok).toBe(true);
  });

  it('returns false on 5xx', async () => {
    sgSend.mockResolvedValue([{ statusCode: 503 }, {}]);
    const ok = await sendEmailNotification({ to: 'a@b.com', subject: 'Test', html: '<p>Hi</p>' });
    expect(ok).toBe(false);
  });

  it('returns false on throw', async () => {
    sgSend.mockRejectedValue(new Error('network'));
    const ok = await sendEmailNotification({ to: 'a@b.com', subject: 'Test', html: '<p>Hi</p>' });
    expect(ok).toBe(false);
  });

  it('returns false when SendGrid not configured', async () => {
    // Re-import without the API key so ensureSendGrid() sees no key
    vi.resetModules();
    delete process.env.SENDGRID_API_KEY;

    const localSend = vi.fn();
    vi.doMock('@sendgrid/mail', () => ({
      default: { setApiKey: vi.fn(), send: localSend },
    }));
    vi.doMock('firebase-admin', () => ({
      default: { firestore: () => ({}), messaging: () => ({}) },
      firestore: Object.assign(() => ({}), {
        FieldValue: {
          serverTimestamp: vi.fn(),
          arrayRemove: vi.fn(),
          arrayUnion: vi.fn(),
          delete: vi.fn(),
        },
        Timestamp: { now: vi.fn(), fromMillis: vi.fn() },
      }),
      messaging: vi.fn(() => ({})),
    }));

    const mod2 = await import('../notifications');
    const ok = await mod2.sendEmailNotification({ to: 'a@b.com', subject: 'Test', html: '<p>Hi</p>' });
    expect(ok).toBe(false);
    expect(localSend).not.toHaveBeenCalled();
  });
});
