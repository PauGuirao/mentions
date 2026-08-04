/**
 * Public enterprise contact endpoint for the landing /enterprise form.
 * Unauthenticated by design (exempted in auth.ts); a honeypot field absorbs
 * dumb bots (they get a fake success and nothing is stored). D1 is the
 * source of truth; the notification email is best-effort.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { createEnterpriseInquiry } from '@mentions/core/ops/enterprise';
import { ResendClient } from '@mentions/core/email';
import { enterpriseInquiryBodySchema } from '@mentions/core/schemas';
import { errorResponse } from '../errors';
import { createRouter } from '../router';

const inquiryRoute = createRoute({
  method: 'post',
  path: '/enterprise/inquiries',
  operationId: 'createEnterpriseInquiry',
  tags: ['Enterprise'],
  request: {
    body: {
      content: { 'application/json': { schema: enterpriseInquiryBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      description: 'Inquiry received',
    },
    400: errorResponse('Invalid inquiry'),
  },
});

export const enterpriseRouter = createRouter();

enterpriseRouter.openapi(inquiryRoute, async (c) => {
  const body = c.req.valid('json');

  // Honeypot tripped: pretend success, store nothing.
  if (body.website && body.website.trim() !== '') {
    return c.json({ ok: true as const }, 200);
  }

  await createEnterpriseInquiry({
    db: c.env.DB,
    company: body.company.trim(),
    name: body.name.trim(),
    email: body.email.trim(),
    keywordsEstimate: body.keywordsEstimate?.trim() || undefined,
    message: body.message?.trim() || undefined,
  });

  // Best-effort heads-up to the team inbox; storage already succeeded.
  if (c.env.RESEND_API_KEY && c.env.ENTERPRISE_INQUIRY_EMAIL) {
    try {
      const resend = new ResendClient({
        apiKey: c.env.RESEND_API_KEY,
        from: c.env.EMAIL_FROM ?? 'Mentio <notifications@mentio.dev>',
      });
      await resend.send({
        to: c.env.ENTERPRISE_INQUIRY_EMAIL,
        subject: `Enterprise inquiry: ${body.company.trim()}`,
        text: [
          `Company: ${body.company.trim()}`,
          `Name: ${body.name.trim()}`,
          `Email: ${body.email.trim()}`,
          `Keywords: ${body.keywordsEstimate?.trim() || '(not given)'}`,
          '',
          body.message?.trim() || '(no message)',
        ].join('\n'),
      });
    } catch (err) {
      console.error('[enterprise] notification email failed', err instanceof Error ? err.message : err);
    }
  }

  return c.json({ ok: true as const }, 200);
});
