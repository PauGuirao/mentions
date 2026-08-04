/**
 * Auth email templates + sender wiring. Copy rules: plain, short, no em
 * dashes (CLAUDE.md). Sending activates when RESEND_API_KEY exists; without
 * it buildAuthEmails returns null and Better Auth simply has no email
 * channel (password reset unavailable, same behavior as before).
 */
import { ResendClient } from '@mentions/core/email';
import type { Env } from './types';

const DEFAULT_FROM = 'Mentio <notifications@mentio.dev>';

interface AuthEmailUser {
  email: string;
  name?: string | null;
}

export interface AuthEmails {
  sendResetPassword(args: { user: AuthEmailUser; url: string }): Promise<void>;
  sendVerificationEmail(args: { user: AuthEmailUser; url: string }): Promise<void>;
  /** Sent to every fresh signup regardless of auth provider. */
  sendWelcome(args: { user: AuthEmailUser; appUrl: string }): Promise<void>;
  sendInvitation(args: {
    email: string;
    orgName: string;
    inviterEmail: string;
    url: string;
  }): Promise<void>;
}

const greeting = (user: AuthEmailUser): string => {
  const name = user.name?.trim();
  return name ? `Hi ${name},` : 'Hi,';
};

export function buildAuthEmails(env: Env): AuthEmails | null {
  if (!env.RESEND_API_KEY) return null;
  const resend = new ResendClient({
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM ?? DEFAULT_FROM,
  });

  return {
    async sendResetPassword({ user, url }) {
      await resend.send({
        to: user.email,
        subject: 'Reset your Mentio password',
        text: [
          greeting(user),
          '',
          'Someone requested a password reset for your Mentio account.',
          'If this was you, open this link to set a new password:',
          '',
          url,
          '',
          'The link expires shortly. If you did not request this, you can ignore this email.',
        ].join('\n'),
      });
    },

    async sendVerificationEmail({ user, url }) {
      await resend.send({
        to: user.email,
        subject: 'Verify your email for Mentio',
        text: [
          greeting(user),
          '',
          'Welcome to Mentio. Confirm this email address to finish setting up your account:',
          '',
          url,
          '',
          'If you did not sign up for Mentio, you can ignore this email.',
        ].join('\n'),
      });
    },

    async sendWelcome({ user, appUrl }) {
      await resend.send({
        to: user.email,
        subject: 'Welcome to Mentio',
        text: [
          greeting(user),
          '',
          'Your Mentio workspace is ready. We watch developer platforms like X,',
          'Reddit, Hacker News and Bluesky for mentions of your brand and',
          'keywords, score how relevant each one is, and surface the ones worth',
          'acting on.',
          '',
          'Jump in here:',
          '',
          appUrl,
          '',
          'Tip: add your website during onboarding and we will suggest the',
          'keywords and competitors to track. You can refine everything later',
          'in Settings, including Slack notifications for new mentions.',
          '',
          'Questions or feedback? Just reply to this email.',
          '',
          'The Mentio team',
        ].join('\n'),
      });
    },

    async sendInvitation({ email, orgName, inviterEmail, url }) {
      await resend.send({
        to: email,
        subject: `You are invited to ${orgName} on Mentio`,
        text: [
          'Hi,',
          '',
          `${inviterEmail} invited you to join the workspace "${orgName}" on Mentio,`,
          'a tool that tracks brand mentions across developer platforms.',
          '',
          'Accept the invitation here:',
          '',
          url,
          '',
          'The invitation expires in 48 hours. If you were not expecting this, you can ignore this email.',
        ].join('\n'),
      });
    },
  };
}
