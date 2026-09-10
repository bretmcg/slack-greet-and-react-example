// Load environment variables from `.env` file (optional)
require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { App, LogLevel } = require('@slack/bolt');

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

// Org-wide installs are keyed by enterprise; everything else by team.
function installationKey(source) {
  if (source.isEnterpriseInstall && source.enterprise) {
    return `enterprise:${source.enterprise.id || source.enterpriseId}`;
  }
  return `team:${(source.team && source.team.id) || source.teamId}`;
}

const successPage = fs.readFileSync(path.join(__dirname, 'views', 'auth.html'));

// *** Initialize the app ***
// signingSecret verifies that requests come from Slack; the OAuth settings
// make Bolt serve /slack/install and /slack/oauth_redirect for "Add to Slack".
const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET || crypto.randomBytes(16).toString('hex'),
  scopes: ['chat:write', 'channels:history', 'reactions:read'],
  installationStore,
  installerOptions: {
    callbackOptions: {
      success: (installation, options, req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
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
  logLevel: process.env.LOG_LEVEL || LogLevel.INFO,
});

// *** Greet any user that says "hi" ***
app.message(/\bhi\b/i, async ({ message, say }) => {
  await say(`Hello <@${message.user}>! :tada:`);
});

// *** Respond to reactions with the same emoji ***
app.event('reaction_added', async ({ event, client }) => {
  if (event.item.type !== 'message') {
    return;
  }
  await client.chat.postMessage({
    channel: event.item.channel,
    text: `:${event.reaction}:`,
  });
});

// *** Handle errors ***
app.error(async (error) => {
  console.error(`An error occurred while handling a Slack event: ${error.message}`);
});

// Start the app, unless another module (e.g. a test) imported it
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.start(port).then(() => {
    console.log(`⚡️ Greet and React is listening on port ${port}`);
  });
}

module.exports = { app, installationStore };
