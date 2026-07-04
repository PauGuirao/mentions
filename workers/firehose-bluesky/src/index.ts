/**
 * mentions-firehose-bluesky — admin surface (/start /stop /status) plus an
 * hourly belt-and-braces restart for the FirehoseConsumer Durable Object.
 */
import { FirehoseConsumer, type Env } from './firehose';

export { FirehoseConsumer };

const SINGLETON_NAME = 'firehose';

const firehoseStub = (env: Env): DurableObjectStub<FirehoseConsumer> =>
  env.FIREHOSE.get(env.FIREHOSE.idFromName(SINGLETON_NAME));

export default {
  async fetch(request, env): Promise<Response> {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response('unauthorized', { status: 401 });
    }

    const stub = firehoseStub(env);
    switch (new URL(request.url).pathname) {
      case '/start':
        return Response.json(await stub.start());
      case '/stop':
        // Holds for at most an hour: the cron below restarts the stream.
        // Deliberate — this DO should always be running.
        return Response.json(await stub.stop());
      case '/status':
        return Response.json(await stub.status());
      default:
        return new Response('not found', { status: 404 });
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    // Belt-and-braces: if the watchdog alarm was ever lost (stop without a
    // matching start, alarm deletion), this revives the stream within the hour.
    ctx.waitUntil(firehoseStub(env).start());
  },
} satisfies ExportedHandler<Env>;
