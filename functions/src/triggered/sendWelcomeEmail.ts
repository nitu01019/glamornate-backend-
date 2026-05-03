import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import sgMail from '@sendgrid/mail';
import { isSendGridConfigured } from '../utils/service-config';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('sendWelcomeEmail');

// Initialize SendGrid if configured
if (isSendGridConfigured()) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
  logger.info('SendGrid initialized for welcome emails');
}

// Welcome email HTML template with Glamornate branding
const WELCOME_EMAIL_TEMPLATE = (displayName: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Glamornate</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #fdf2f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header with Rose/Gold gradient -->
    <tr>
      <td style="background: linear-gradient(135deg, #be123c 0%, #c4a57b 100%); padding: 40px 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 300; letter-spacing: 2px;">
          GLAMORNATE
        </h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px; letter-spacing: 1px;">
          Discover Your Perfect Spa Experience
        </p>
      </td>
    </tr>
    
    <!-- Welcome Message -->
    <tr>
      <td style="padding: 40px 30px;">
        <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px; font-weight: 500;">
          Welcome, ${displayName}!
        </h2>
        <p style="color: #4b5563; line-height: 1.6; font-size: 16px; margin: 0 0 20px 0;">
          We're thrilled to have you join the Glamornate community. Your journey to relaxation and rejuvenation starts here.
        </p>
        <p style="color: #4b5563; line-height: 1.6; font-size: 16px; margin: 0 0 30px 0;">
          Discover premium spa experiences, book appointments with ease, and enjoy exclusive member benefits.
        </p>
      </td>
    </tr>
    
    <!-- Getting Started Steps -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <h3 style="color: #be123c; margin: 0 0 20px 0; font-size: 18px;">Getting Started</h3>
        
        <!-- Step 1 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 15px;">
          <tr>
            <td width="50" style="vertical-align: top;">
              <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #be123c 0%, #c4a57b 100%); border-radius: 50%; text-align: center; line-height: 36px; color: #fff; font-weight: bold;">1</div>
            </td>
            <td style="vertical-align: top; padding-left: 10px;">
              <p style="color: #1f2937; font-weight: 500; margin: 0 0 5px 0;">Browse Spas Near You</p>
              <p style="color: #6b7280; font-size: 14px; margin: 0;">Explore our curated selection of premium spas and wellness centers.</p>
            </td>
          </tr>
        </table>
        
        <!-- Step 2 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 15px;">
          <tr>
            <td width="50" style="vertical-align: top;">
              <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #be123c 0%, #c4a57b 100%); border-radius: 50%; text-align: center; line-height: 36px; color: #fff; font-weight: bold;">2</div>
            </td>
            <td style="vertical-align: top; padding-left: 10px;">
              <p style="color: #1f2937; font-weight: 500; margin: 0 0 5px 0;">Choose Your Services</p>
              <p style="color: #6b7280; font-size: 14px; margin: 0;">From massages to facials, find treatments tailored to your needs.</p>
            </td>
          </tr>
        </table>
        
        <!-- Step 3 -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="50" style="vertical-align: top;">
              <div style="width: 36px; height: 36px; background: linear-gradient(135deg, #be123c 0%, #c4a57b 100%); border-radius: 50%; text-align: center; line-height: 36px; color: #fff; font-weight: bold;">3</div>
            </td>
            <td style="vertical-align: top; padding-left: 10px;">
              <p style="color: #1f2937; font-weight: 500; margin: 0 0 5px 0;">Book & Relax</p>
              <p style="color: #6b7280; font-size: 14px; margin: 0;">Secure your appointment instantly and enjoy a seamless experience.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    
    <!-- CTA Button -->
    <tr>
      <td style="padding: 0 30px 40px; text-align: center;">
        <a href="https://glamornate.com/spas" style="display: inline-block; background: linear-gradient(135deg, #be123c 0%, #c4a57b 100%); color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 8px; font-size: 16px; font-weight: 500; letter-spacing: 0.5px;">
          Explore Spas
        </a>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background-color: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
        <p style="color: #6b7280; font-size: 14px; margin: 0 0 10px 0;">
          Need help? Contact us at <a href="mailto:support@glamornate.com" style="color: #be123c;">support@glamornate.com</a>
        </p>
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">
          © ${new Date().getFullYear()} Glamornate. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
`;

export const sendWelcomeEmail = functions.firestore
  .document('users/{userId}')
  .onCreate(async (snap, context) => {
    const user = snap.data();
    const userId = context.params.userId;

    logger.info('Processing new user registration', {
      userId,
      hasEmail: Boolean(user.email),
    });

    // Only proceed if email is provided
    if (!user.email) {
      logger.warn('No email provided for user, skipping welcome email', { userId });
      return null;
    }

    const displayName = user.profile?.displayName || user.displayName || 'there';
    const emailSubject = 'Welcome to Glamornate!';
    const emailHtml = WELCOME_EMAIL_TEMPLATE(displayName);

    // Try to send welcome email
    if (isSendGridConfigured()) {
      // ===== SENDGRID MODE: Send actual email =====
      try {
        await sgMail.send({
          to: user.email,
          from: {
            email: 'welcome@glamornate.com',
            name: 'Glamornate',
          },
          subject: emailSubject,
          html: emailHtml,
          text: stripHtml(emailHtml),
          trackingSettings: {
            clickTracking: { enable: true },
            openTracking: { enable: true },
          },
        });

        logger.info('Welcome email sent successfully', {
          userId,
          email: user.email,
        });
      } catch (emailError: unknown) {
        const err = emailError as Record<string, unknown>;
        logger.error('Failed to send welcome email via SendGrid', {
          userId,
          email: user.email,
          error: emailError instanceof Error ? emailError.message : String(emailError),
          code: err.code,
        });
        // Don't throw - email failure shouldn't block user creation flow
      }
    } else {
      // ===== LOGGING MODE: Log email content =====
      logger.warn('SendGrid not configured - logging welcome email content', {
        mode: 'demo',
        email: {
          to: user.email,
          from: 'welcome@glamornate.com',
          subject: emailSubject,
          recipientName: displayName,
        },
        message: 'Configure SENDGRID_API_KEY to send actual emails',
      });
    }

    // Create in-app notification (always works)
    try {
      const notificationRef = db.collection('notifications').doc();
      await notificationRef.set({
        userId,
        type: 'welcome',
        title: 'Welcome to Glamornate!',
        body: 'Discover and book the best spa and massage experiences near you.',
        data: { type: 'welcome' },
        read: false,
        channels: {
          push: true,
          email: isSendGridConfigured(),
          sms: false,
        },
        deliveryStatus: isSendGridConfigured() ? 'sent' : 'email_skipped',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info('Welcome notification created', { userId, notificationId: notificationRef.id });
    } catch (notificationError: unknown) {
      logger.error('Failed to create welcome notification', notificationError instanceof Error ? { message: notificationError.message, stack: notificationError.stack } : { error: String(notificationError) });
    }

    // Create wallet for new user
    try {
      const walletRef = db.collection('wallets').doc();
      await walletRef.set({
        userId,
        currency: 'INR',
        balance: {
          current: 0,
          credited: 0,
          debited: 0,
        },
        transactions: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info('User wallet created', { userId, walletId: walletRef.id });
    } catch (walletError: unknown) {
      logger.error('Failed to create user wallet', walletError instanceof Error ? { message: walletError.message, stack: walletError.stack } : { error: String(walletError) });
    }

    // Create audit log
    try {
      await db.collection('audit_logs').add({
        userId,
        action: 'user_created',
        entity: { type: 'user', id: userId },
        before: null,
        after: {
          email: user.email,
          role: user.role,
          displayName,
        },
        metadata: {
          authProvider: user.authProvider,
          welcomeEmailSent: isSendGridConfigured(),
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (auditError: unknown) {
      logger.error('Failed to create audit log', auditError instanceof Error ? { message: auditError.message, stack: auditError.stack } : { error: String(auditError) });
    }

    return null;
  });

/**
 * Strip HTML tags to create plain text version
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
