// End-to-end smoke test.
//
// Drives the real Bolt HTTP receiver with correctly signed requests and points
// the Slack client at a local mock API, so it needs no credentials and no
// network. Run with `npm test`.

const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.SLACK_CLIENT_ID = '1.2';
process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
process.env.SLACK_STATE_SECRET = 'test-state-secret';
process.env.LOG_LEVEL = 'error';

const { app, installationStore } = require('..');

const BOT_USER_ID = 'UBOT';
const BOT_ID = 'B1';

// --- Mock Slack API ------------------------------------------------------

const apiCalls = [];
const mockSlack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    apiCalls.push({
      method: req.url.replace(/^\//, ''),
      body: Object.fromEntries(new URLSearchParams(body)),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ts: '1.2', channel: 'C1' }));
  });
});

// --- Helpers -------------------------------------------------------------

function post(port, path, payload, { sign = true } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': sign ? signature : 'v0=not-the-right-signature',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, blocked: data }));
      })
      .on('error', reject);
  });
}

// Listeners run after Bolt acks, so give them a moment to reach the mock API.
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function envelope(event, overrides = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event_time: 1,
    event,
    ...overrides,
  };
}

function teamInstall(teamId, token) {
  return {
    team: { id: teamId, name: teamId },
    enterprise: undefined,
    isEnterpriseInstall: false,
    bot: { token, id: BOT_ID, userId: BOT_USER_ID, scopes: ['chat:write'] },
    user: { id: 'U1' },
    tokenType: 'bot',
    authVersion: 'v2',
  };
}

function orgInstall(enterpriseId, token) {
  return {
    team: undefined,
    enterprise: { id: enterpriseId, name: enterpriseId },
    isEnterpriseInstall: true,
    bot: { token, id: BOT_ID, userId: BOT_USER_ID, scopes: ['chat:write'] },
    user: { id: 'U1' },
    tokenType: 'bot',
    authVersion: 'v2',
  };
}

const posts = () => apiCalls.filter((call) => call.method === 'chat.postMessage');

let passed = 0;
async function check(name, fn) {
  apiCalls.length = 0;
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- Tests ---------------------------------------------------------------

async function main() {
  await new Promise((resolve) => mockSlack.listen(0, resolve));
  app.clientOptions.slackApiUrl = `http://127.0.0.1:${mockSlack.address().port}/`;

  await installationStore.storeInstallation(teamInstall('T1', 'xoxb-team'));

  await app.start(0);
  const port = app.receiver.server.address().port;

  console.log('installation store');

  // The store is written with an Installation and read with an InstallationQuery,
  // which have different shapes. Both directions have to agree on the key.
  await check('team install round-trips', async () => {
    const found = await installationStore.fetchInstallation({ teamId: 'T1', isEnterpriseInstall: false });
    assert.strictEqual(found.bot.token, 'xoxb-team');
  });

  await check('org-wide install round-trips', async () => {
    await installationStore.storeInstallation(orgInstall('E1', 'xoxb-org'));
    const found = await installationStore.fetchInstallation({
      enterpriseId: 'E1',
      teamId: undefined,
      isEnterpriseInstall: true,
    });
    assert.strictEqual(found.bot.token, 'xoxb-org');
  });

  await check('two org installs stay distinct', async () => {
    await installationStore.storeInstallation(orgInstall('E2', 'xoxb-org-2'));
    const first = await installationStore.fetchInstallation({ enterpriseId: 'E1', isEnterpriseInstall: true });
    const second = await installationStore.fetchInstallation({ enterpriseId: 'E2', isEnterpriseInstall: true });
    assert.strictEqual(first.bot.token, 'xoxb-org');
    assert.strictEqual(second.bot.token, 'xoxb-org-2');
  });

  await check('a grid team that is not an org install is keyed by team', async () => {
    await installationStore.storeInstallation({
      ...teamInstall('T9', 'xoxb-grid-team'),
      enterprise: { id: 'E1', name: 'E1' },
    });
    const found = await installationStore.fetchInstallation({
      teamId: 'T9',
      enterpriseId: 'E1',
      isEnterpriseInstall: false,
    });
    assert.strictEqual(found.bot.token, 'xoxb-grid-team');
  });

  await check('deleting removes only the matching install', async () => {
    await installationStore.deleteInstallation({ enterpriseId: 'E2', isEnterpriseInstall: true });
    await assert.rejects(() =>
      installationStore.fetchInstallation({ enterpriseId: 'E2', isEnterpriseInstall: true }));
    const survivor = await installationStore.fetchInstallation({ teamId: 'T1', isEnterpriseInstall: false });
    assert.strictEqual(survivor.bot.token, 'xoxb-team');
  });

  console.log('routes');

  await check('/ redirects to the install page', async () => {
    const res = await get(port, '/');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/slack/install');
  });

  await check('/slack/install renders Add to Slack', async () => {
    const res = await get(port, '/slack/install');
    assert.strictEqual(res.status, 200);
    assert.match(res.blocked, /add_to_slack/);
  });

  await check('url_verification echoes the challenge', async () => {
    const res = await post(port, '/slack/events', { type: 'url_verification', challenge: 'abc123' });
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /abc123/);
  });

  await check('a bad signature is rejected with 401', async () => {
    const res = await post(port, '/slack/events', { type: 'url_verification', challenge: 'x' }, { sign: false });
    assert.strictEqual(res.status, 401);
  });

  console.log('greeting');

  await check('greets a plain "hi"', async () => {
    const res = await post(port, '/slack/events', envelope({
      type: 'message', channel: 'C1', user: 'U2', text: 'oh hi there', ts: '1.1',
    }));
    assert.strictEqual(res.status, 200);
    await settle();
    assert.strictEqual(posts().length, 1);
    assert.strictEqual(posts()[0].body.channel, 'C1');
    assert.strictEqual(posts()[0].body.text, 'Hello <@U2>! :tada:');
  });

  await check('ignores a message with no "hi" as a word', async () => {
    await post(port, '/slack/events', envelope({
      type: 'message', channel: 'C1', user: 'U2', text: 'this is nothing', ts: '1.2',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  await check('ignores its own message', async () => {
    await post(port, '/slack/events', envelope({
      type: 'message', subtype: 'bot_message', channel: 'C1', user: BOT_USER_ID,
      bot_id: BOT_ID, text: 'hi', ts: '1.3',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  // A bot_message carries text but no `user`, so greeting it would render
  // "Hello <@undefined>" and start bot-to-bot ping-pong.
  await check('ignores another app\'s bot_message', async () => {
    await post(port, '/slack/events', envelope({
      type: 'message', subtype: 'bot_message', channel: 'C1', bot_id: 'B-OTHER',
      username: 'Some Workflow', text: 'hi everyone', ts: '1.4',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  await check('ignores a file_comment, which has no user', async () => {
    await post(port, '/slack/events', envelope({
      type: 'message', subtype: 'file_comment', channel: 'C1', text: 'hi from a comment', ts: '1.5',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  await check('replies inside the thread it was greeted in', async () => {
    await post(port, '/slack/events', envelope({
      type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '1.7', thread_ts: '1.6',
    }));
    await settle();
    assert.strictEqual(posts().length, 1);
    assert.strictEqual(posts()[0].body.thread_ts, '1.6');
  });

  console.log('reactions');

  await check('echoes a reaction with the same emoji', async () => {
    await post(port, '/slack/events', envelope({
      type: 'reaction_added', user: 'U2', reaction: 'thumbsup', item_user: 'U3',
      item: { type: 'message', channel: 'C9', ts: '1.0' }, event_ts: '1.8',
    }));
    await settle();
    assert.strictEqual(posts().length, 1);
    assert.strictEqual(posts()[0].body.channel, 'C9');
    assert.strictEqual(posts()[0].body.text, ':thumbsup:');
  });

  await check('ignores a reaction on a file', async () => {
    await post(port, '/slack/events', envelope({
      type: 'reaction_added', user: 'U2', reaction: 'thumbsup', item_user: 'U3',
      item: { type: 'file', file: 'F1' }, event_ts: '1.9',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  await check('ignores a reaction on its own message', async () => {
    await post(port, '/slack/events', envelope({
      type: 'reaction_added', user: 'U2', reaction: 'tada', item_user: BOT_USER_ID,
      item: { type: 'message', channel: 'C9', ts: '1.0' }, event_ts: '2.0',
    }));
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  console.log('authorization');

  await check('handles an event from an org-wide install', async () => {
    const res = await post(port, '/slack/events', envelope({
      type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '2.1',
    }, { team_id: undefined, enterprise_id: 'E1', is_enterprise_install: true }));
    assert.strictEqual(res.status, 200);
    await settle();
    assert.strictEqual(posts().length, 1);
    assert.strictEqual(posts()[0].body.text, 'Hello <@U2>! :tada:');
  });

  await check('acks an event from an unknown workspace without posting', async () => {
    const res = await post(port, '/slack/events', envelope({
      type: 'message', channel: 'C1', user: 'U2', text: 'hi', ts: '2.2',
    }, { team_id: 'T-NOT-INSTALLED' }));
    assert.strictEqual(res.status, 200);
    await settle();
    assert.strictEqual(posts().length, 0);
  });

  await app.stop();
  mockSlack.close();
  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exit(1);
});
