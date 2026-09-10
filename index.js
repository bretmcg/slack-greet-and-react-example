// Load environment variables from `.env` file (optional)
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { App, LogLevel } = require('@slack/bolt');

// The OAuth `state` parameter is a JWT signed with this secret, issued on
// /slack/install and verified on /slack/oauth_redirect. A per-process random
// value would break any install that spans a restart or a second instance, so
// require it rather than generating one.
if (!process.env.SLACK_STATE_SECRET) {
  throw new Error(
    'SLACK_STATE_SECRET is required. Use any random string, and keep it stable across ' +
    'restarts and across instances, or in-flight installs will fail with an opaque 400.'
  );
}

// *** Installation store ***
// Bolt calls this after each "Add to Slack" and before handling each event.
// This in-memory version is fine for a demo; a real app would use a database.
const installations = new Map();
const installationStore = {
  async storeInstallation(installation) {
    installations.set(installationKey(installation), installation);
  },
  async fetchInstallation(query) {
    const installation = installations.get(installationKey(query));
    if (!installation) {
      throw new Error('No installation found for this workspace. Did you install the app again after restarting?');
    }
    return installation;
  },
  async deleteInstallation(query) {
    installations.delete(installationKey(query));
  },
};

// Org-wide installs are keyed by enterprise, everything else by team.
// Note the two shapes: storing passes an Installation (nested `enterprise`/`team`
// objects), while fetching and deleting pass an InstallationQuery (flat
// `enterpriseId`/`teamId` strings). Read both or the key won't round-trip.
function installationKey(source) {
  const enterpriseId = source.enterpriseId || (source.enterprise && source.enterprise.id);
  const teamId = source.teamId || (source.team && source.team.id);
  if (source.isEnterpriseInstall && enterpriseId) {
    return `enterprise:${enterpriseId}`;
  }
  return `team:${teamId}`;
}

const successPage = fs.readFileSync(path.join(__dirname, 'views', 'auth.html'));

// An unrecognized level leaves every log call silently disabled, so fall back
// instead of passing it straight through.
const requestedLogLevel = String(process.env.LOG_LEVEL || '').toLowerCase();
const logLevel = Object.values(LogLevel).includes(requestedLogLevel) ? requestedLogLevel : LogLevel.INFO;

// *** Initialize the app ***
// signingSecret verifies that requests come from Slack; the OAuth settings
// make Bolt serve /slack/install and /slack/oauth_redirect for "Add to Slack".
const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ['chat:write', 'channels:history', 'reactions:read'],
  installationStore,
  installerOptions: {
    callbackOptions: {
      success: (installation, options, req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successPage);
      },
    },
  },
  customRoutes: [
    {
      path: '/',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(302, { Location: '/slack/install' });
        res.end();
      },
    },
  ],
  extendedErrorHandler: true,
  logLevel,
});

// *** Greet any user that says "hi" ***
app.message(/\bhi\b/i, async ({ message, say }) => {
  // Bolt's message matcher filters on text alone, so subtypes such as
  // bot_message and file_comment reach this listener with no `user` to greet.
  if (!message.user) {
    return;
  }
  // thread_ts keeps a greeting in the thread it was triggered from; it is
  // undefined for channel-level messages, which posts to the channel.
  await say({ text: `Hello <@${message.user}>! :tada:`, thread_ts: message.thread_ts });
});

// *** Respond to reactions with the same emoji ***
app.event('reaction_added', async ({ event, client, context }) => {
  if (event.item.type !== 'message') {
    return;
  }
  // Bolt already drops reactions the bot itself adds. This drops reactions to
  // the bot's own messages, which otherwise makes a busy channel very noisy.
  if (event.item_user === context.botUserId) {
    return;
  }
  // reaction_added carries no parent thread_ts, so the echo goes to the channel.
  // Placing it in the thread would need a conversations.replies lookup.
  await client.chat.postMessage({
    channel: event.item.channel,
    text: `:${event.reaction}:`,
  });
});

// *** Handle errors ***
// Logging the error object rather than error.message keeps `code` and the
// underlying Slack API response, which is what you need to diagnose failures
// like not_in_channel. Listeners run after Bolt has already acked, so throwing
// here would not make Slack retry.
app.error(async ({ error, logger, body }) => {
  logger.error('Failed to handle a Slack event', {
    error,
    eventType: body && body.event && body.event.type,
  });
});

// Start the app, unless another module (e.g. a test) imported it
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.start(port)
    .then(() => {
      console.log(`⚡️ Greet and React is listening on port ${port}`);
    })
    .catch((error) => {
      console.error(`Failed to start on port ${port}: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { app, installationStore };
