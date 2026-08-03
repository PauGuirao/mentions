/**
 * Seeds the LOCAL D1 database with demo mentions for the most recent org whose
 * brand_name matches DEMO_BRAND (default "Resend"), so the dashboard can be
 * seen full. Idempotent: fixed ids + INSERT OR IGNORE, safe to re-run.
 * Run from workers/api via `pnpm exec tsx scripts/seed-demo-mentions.ts`
 * while `wrangler dev` is STOPPED (local D1 writes crash a live workerd).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEMO_BRAND = process.argv[2] ?? 'Resend';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const now = Date.now();

interface DemoMention {
  source: string;
  url: string;
  author: string;
  authorUrl?: string;
  text: string;
  agoMs: number;
  term: string; // normalized_term of the keyword to match
  state: string;
  relevance: number | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  intents: string[];
  aiNote: string | null;
}

const DEMO: DemoMention[] = [
  {
    source: 'bluesky',
    url: 'https://bsky.app/profile/maria.dev/post/3demo001',
    author: 'maria.dev',
    authorUrl: 'https://bsky.app/profile/maria.dev',
    text: 'Looking for recommendations: what are people using for transactional email these days? Needs good DX, webhooks, and EU data residency. Budget is not huge.',
    agoMs: 1 * HOUR,
    term: 'email api',
    state: 'delivered',
    relevance: 88,
    sentiment: 'neutral',
    intents: ['buy_intent', 'question'],
    aiNote: 'Active buyer asking for transactional email recommendations.',
  },
  {
    source: 'hackernews',
    url: 'https://news.ycombinator.com/item?id=41000001',
    author: 'inboxzero',
    text: 'Show HN: I built an open-source newsletter tool on top of Resend. The API is honestly the nicest email API I have used, the React Email integration saved me a week.',
    agoMs: 3 * HOUR,
    term: 'resend',
    state: 'delivered',
    relevance: 94,
    sentiment: 'positive',
    intents: ['praise'],
    aiNote: 'Public praise of the product inside a Show HN launch.',
  },
  {
    source: 'x',
    url: 'https://x.com/shipfastdev/status/1800000000000000001',
    author: 'shipfastdev',
    authorUrl: 'https://x.com/shipfastdev',
    text: 'Sendgrid support has been ghosting us for a week while our domain reputation tanks. Seriously considering moving everything somewhere else. Any suggestions?',
    agoMs: 6 * HOUR,
    term: 'sendgrid',
    state: 'delivered',
    relevance: 86,
    sentiment: 'negative',
    intents: ['complaint', 'buy_intent'],
    aiNote: 'Competitor complaint with clear switching intent.',
  },
  {
    source: 'reddit',
    url: 'https://reddit.com/r/webdev/comments/demo04',
    author: 'u/side_project_sam',
    authorUrl: 'https://reddit.com/user/side_project_sam',
    text: 'Is Resend down for anyone else? Emails have been stuck in queued for 20 minutes. Status page says operational but nothing is going out from eu-west.',
    agoMs: 9 * HOUR,
    term: 'resend',
    state: 'delivered',
    relevance: 90,
    sentiment: 'negative',
    intents: ['question', 'complaint'],
    aiNote: 'Possible incident report from a customer, worth a fast reply.',
  },
  {
    source: 'stackoverflow',
    url: 'https://stackoverflow.com/questions/78000001',
    author: 'devcurious',
    text: 'How do I send an email with a PDF attachment using the Resend Node SDK? The docs cover buffers but my file comes from S3 as a stream and I keep getting a 422.',
    agoMs: 14 * HOUR,
    term: 'resend',
    state: 'delivered',
    relevance: 87,
    sentiment: 'neutral',
    intents: ['question'],
    aiNote: 'Support-style SDK question, good docs feedback signal.',
  },
  {
    source: 'devto',
    url: 'https://dev.to/buildlog/we-switched-from-sendgrid-demo',
    author: 'buildlog',
    authorUrl: 'https://dev.to/buildlog',
    text: 'We switched from Sendgrid to Resend last sprint. Migration took one afternoon, deliverability went up, and the DX difference is night and day. Wrote up the full comparison with numbers.',
    agoMs: 1 * DAY + 2 * HOUR,
    term: 'resend',
    state: 'done',
    relevance: 95,
    sentiment: 'positive',
    intents: ['praise', 'comparison'],
    aiNote: 'Detailed switching story naming us as the winner.',
  },
  {
    source: 'github',
    url: 'https://github.com/resend/resend-node/issues/900',
    author: 'octoketa',
    authorUrl: 'https://github.com/octoketa',
    text: 'Batch send silently drops recipients over the 100 limit instead of raising. Took us a day to notice during a campaign. Can the SDK throw or at least warn?',
    agoMs: 1 * DAY + 8 * HOUR,
    term: 'resend',
    state: 'delivered',
    relevance: 89,
    sentiment: 'negative',
    intents: ['complaint'],
    aiNote: 'Actionable SDK bug report affecting campaigns.',
  },
  {
    source: 'youtube',
    url: 'https://youtube.com/watch?v=demo0008',
    author: 'CodeWithLena',
    text: 'Mailgun vs Sendgrid vs Resend in 2026: I sent 10k emails through each and compared deliverability, pricing and DX. Timestamps in the description.',
    agoMs: 2 * DAY,
    term: 'mailgun',
    state: 'delivered',
    relevance: 84,
    sentiment: 'neutral',
    intents: ['comparison'],
    aiNote: 'Three-way comparison video including our product.',
  },
  {
    source: 'bluesky',
    url: 'https://bsky.app/profile/tomws.dev/post/3demo009',
    author: 'tomws.dev',
    authorUrl: 'https://bsky.app/profile/tomws.dev',
    text: 'The Resend dashboard is what every dev tool should feel like. Set up DKIM, sent my first email and had webhooks running before my coffee got cold.',
    agoMs: 2 * DAY + 5 * HOUR,
    term: 'resend',
    state: 'ignored',
    relevance: 91,
    sentiment: 'positive',
    intents: ['praise'],
    aiNote: 'Organic praise for onboarding speed.',
  },
  {
    source: 'reddit',
    url: 'https://reddit.com/r/SaaS/comments/demo10',
    author: 'u/bootstrapped_ben',
    text: 'Mailgun just doubled the price of our plan at renewal with two weeks notice. Anyone else? What are you all migrating to for transactional email?',
    agoMs: 3 * DAY,
    term: 'mailgun',
    state: 'delivered',
    relevance: 82,
    sentiment: 'negative',
    intents: ['complaint', 'buy_intent'],
    aiNote: 'Competitor pricing backlash, migration question open.',
  },
  {
    source: 'hackernews',
    url: 'https://news.ycombinator.com/item?id=41000011',
    author: 'smtpwizard',
    text: 'Ask HN: Best practices for email deliverability in 2026? We do everything right (SPF, DKIM, DMARC, warmup) and still land in spam for Outlook recipients.',
    agoMs: 3 * DAY + 6 * HOUR,
    term: 'deliverability',
    state: 'delivered',
    relevance: 72,
    sentiment: 'neutral',
    intents: ['question'],
    aiNote: 'High-signal thread in our topic space, good place to help.',
  },
  {
    source: 'stackoverflow',
    url: 'https://stackoverflow.com/questions/78000012',
    author: 'newsletter_nina',
    text: 'DKIM passes but DMARC fails with p=quarantine on a subdomain. Emails from our app go to spam in Gmail. What is the correct alignment setup for a sending subdomain?',
    agoMs: 4 * DAY,
    term: 'deliverability',
    state: 'classified',
    relevance: 61,
    sentiment: 'neutral',
    intents: ['question'],
    aiNote: 'Topic-adjacent DNS alignment question.',
  },
  {
    source: 'x',
    url: 'https://x.com/frontendfiona/status/1800000000000000013',
    author: 'frontendfiona',
    authorUrl: 'https://x.com/frontendfiona',
    text: 'React Email plus Resend is such a good combo. Designed, tested and shipped a full transactional email suite in a day. The preview workflow is chefs kiss.',
    agoMs: 4 * DAY + 7 * HOUR,
    term: 'resend',
    state: 'delivered',
    relevance: 93,
    sentiment: 'positive',
    intents: ['praise'],
    aiNote: 'Praise highlighting the React Email integration.',
  },
  {
    source: 'devto',
    url: 'https://dev.to/apichronicles/email-api-tutorial-demo',
    author: 'apichronicles',
    text: 'Tutorial: building a notification service with queues, retries and an email API. I use a generic provider here but the pattern works with any of them.',
    agoMs: 5 * DAY,
    term: 'email api',
    state: 'classified',
    relevance: 58,
    sentiment: 'neutral',
    intents: [],
    aiNote: 'Generic tutorial in the space, provider-agnostic.',
  },
  {
    source: 'news',
    url: 'https://techpress.example.com/articles/email-deliverability-2026',
    author: 'TechPress',
    text: 'Gmail and Yahoo tighten bulk sender rules again: what the new one-click unsubscribe and spam-rate thresholds mean for SaaS companies sending transactional email.',
    agoMs: 5 * DAY + 9 * HOUR,
    term: 'deliverability',
    state: 'delivered',
    relevance: 66,
    sentiment: 'neutral',
    intents: [],
    aiNote: 'Industry news affecting all senders in our market.',
  },
  {
    source: 'github',
    url: 'https://github.com/awesome-selfhosted/awesome-selfhosted/pull/4200',
    author: 'listmaintainer',
    text: 'Add three new self-hosted email API projects to the list, including SMTP relays with REST wrappers and a webhook bridge.',
    agoMs: 6 * DAY,
    term: 'email api',
    state: 'filtered',
    relevance: 31,
    sentiment: 'neutral',
    intents: [],
    aiNote: 'Keyword hit on an awesome-list, not relevant to us.',
  },
  {
    source: 'reddit',
    url: 'https://reddit.com/r/nextjs/comments/demo17',
    author: 'u/hooks_hannah',
    text: 'What is everyone using for emails in Next.js server actions? Comparing Resend, Postmark and SES. Resend looks nicest but is it reliable at 500k emails a month?',
    agoMs: 7 * DAY,
    term: 'resend',
    state: 'delivered',
    relevance: 92,
    sentiment: 'neutral',
    intents: ['comparison', 'buy_intent', 'question'],
    aiNote: 'Evaluation thread comparing us with alternatives at scale.',
  },
  {
    source: 'hackernews',
    url: 'https://news.ycombinator.com/item?id=41000018',
    author: 'devopsdana',
    text: 'Sendgrid had another partial outage yesterday, third this quarter. Our on-call got paged at 3am because password resets were failing. Time to add a fallback provider.',
    agoMs: 8 * DAY,
    term: 'sendgrid',
    state: 'delivered',
    relevance: 79,
    sentiment: 'negative',
    intents: ['complaint'],
    aiNote: 'Competitor reliability complaint, fallback discussion.',
  },
  {
    source: 'youtube',
    url: 'https://youtube.com/watch?v=demo0019',
    author: 'FullStackFelix',
    text: 'Send emails from your app in 10 minutes with Resend: domains, React Email templates, webhooks and testing. Full walkthrough with code in the repo.',
    agoMs: 10 * DAY,
    term: 'resend',
    state: 'delivered',
    relevance: 90,
    sentiment: 'positive',
    intents: [],
    aiNote: 'Third-party tutorial video featuring the product.',
  },
  {
    source: 'news',
    url: 'https://martechdaily.example.com/articles/email-roi-2026',
    author: 'MarTech Daily',
    text: 'Email still tops marketing ROI in 2026 survey of 2,000 companies; deliverability and list hygiene cited as the main challenges for growth teams.',
    agoMs: 11 * DAY,
    term: 'deliverability',
    state: 'filtered',
    relevance: 34,
    sentiment: 'neutral',
    intents: [],
    aiNote: 'Marketing survey, only tangential to our product.',
  },
  {
    source: 'bluesky',
    url: 'https://bsky.app/profile/qa.qamila/post/3demo021',
    author: 'qa.qamila',
    text: 'Hot take: most deliverability problems are self-inflicted. Warm up your domain, verify your list, stop buying leads. The provider is rarely the issue.',
    agoMs: 12 * DAY,
    term: 'deliverability',
    state: 'classified',
    relevance: 55,
    sentiment: 'neutral',
    intents: [],
    aiNote: 'Opinion post in the deliverability conversation.',
  },
  {
    source: 'stackoverflow',
    url: 'https://stackoverflow.com/questions/78000022',
    author: 'cronjob_carl',
    text: 'Cheapest email API for a hobby project sending under 100 emails a month? Free tiers compared: I need custom domains and decent docs, nothing fancy.',
    agoMs: 13 * DAY,
    term: 'email api',
    state: 'delivered',
    relevance: 74,
    sentiment: 'neutral',
    intents: ['question', 'comparison'],
    aiNote: 'Free-tier shopper comparing providers.',
  },
];

const q = (value: string): string => value.replace(/'/g, "''");
const orgSub = `(SELECT id FROM orgs WHERE brand_name = '${q(DEMO_BRAND)}' ORDER BY created_at DESC LIMIT 1)`;

const statements: string[] = [];
DEMO.forEach((m, i) => {
  const id = String(i + 1).padStart(3, '0');
  const publishedAt = now - m.agoMs;
  const authorUrl = m.authorUrl ? `'${q(m.authorUrl)}'` : 'NULL';
  statements.push(
    `INSERT OR IGNORE INTO mentions (id, source, external_id, url, author, author_url, text, published_at, raw_r2_key, created_at) VALUES ('men_demo_${id}', '${m.source}', 'demo_${id}', '${q(m.url)}', '${q(m.author)}', ${authorUrl}, '${q(m.text)}', ${publishedAt}, NULL, ${publishedAt});`,
  );
  const relevance = m.relevance === null ? 'NULL' : String(m.relevance);
  const sentiment = m.sentiment === null ? 'NULL' : `'${m.sentiment}'`;
  const aiNote = m.aiNote === null ? 'NULL' : `'${q(m.aiNote)}'`;
  statements.push(
    `INSERT OR IGNORE INTO mention_matches (id, org_id, mention_id, keyword_id, state, relevance, sentiment, intents, ai_note, created_at) VALUES ('mm_demo_${id}', ${orgSub}, 'men_demo_${id}', (SELECT id FROM keywords WHERE org_id = ${orgSub} AND normalized_term = '${q(m.term)}'), '${m.state}', ${relevance}, ${sentiment}, '${JSON.stringify(m.intents)}', ${aiNote}, ${publishedAt + 60_000});`,
  );
});

const workerDir = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(
  'wrangler',
  ['d1', 'execute', 'mentions', '--local', '--command', statements.join(' ')],
  { cwd: workerDir, stdio: 'inherit' },
);

if (result.error) {
  console.error('Failed to run wrangler (run via pnpm exec so it is on PATH):', result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`\nSeeded ${DEMO.length} demo mentions for brand "${DEMO_BRAND}".`);
