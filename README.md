# Greet and React Example

A fully functioning but very simple multi-workspace Slack app built with
[Bolt for JavaScript](https://tools.slack.dev/bolt-js/). It greets anyone who
says "hi" in a channel, and replies to reactions with the same emoji.

The whole app is [`index.js`](index.js). Bolt handles the "Add to Slack" OAuth
flow, request signature verification, and event routing, so there is no
separate OAuth or web framework to wire up.

## Setup

### Create a Slack app
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From a manifest**, pick a workspace, and paste the contents of
   [`manifest.json`](manifest.json). Replace both `YOUR-PUBLIC-URL` placeholders
   with your ngrok or hosting URL if you already have one; otherwise leave them
   and correct both under "Point Slack at your app" below.
3. On the **Basic Information** page, note the _Client ID_, _Client Secret_ and _Signing Secret_

You will come back to the app settings once you have a public URL.

### Run locally

1. Clone this repo and run `npm install` (Node.js 20 or newer)
2. Copy `.env.sample` to `.env` and fill in:
	- `SLACK_CLIENT_ID`: Your app's _Client ID_
	- `SLACK_CLIENT_SECRET`: Your app's _Client Secret_
	- `SLACK_SIGNING_SECRET`: Your app's _Signing Secret_
	- `SLACK_STATE_SECRET`: Any random string, e.g. `openssl rand -hex 32`. Keep it
	  stable across restarts and instances, or an install started before a restart
	  fails its callback.
3. Start the app: `npm start`
4. In another window, expose it publicly, e.g. `ngrok http $PORT`

### Point Slack at your app
1. In the app settings, open **OAuth & Permissions** and add a _Redirect URL_:
	- your public URL + `/slack/oauth_redirect`
2. Open **Event Subscriptions** and set the _Request URL_:
	- your public URL + `/slack/events`

   Slack sends a verification request; the app must be running for it to succeed.
3. Confirm the bot events `message.channels` and `reaction_added` are subscribed
   (the manifest adds them for you) and save.

If you are upgrading an app that ran the previous version of this sample,
**replace** the old `/auth/slack/callback` redirect URL rather than adding to it.
That path no longer exists and now returns 404.

## Installation and Usage
1. Visit your public URL and click the **Add to Slack** button
2. Invite the bot into a channel (e.g. `/invite @greetandreact`), and say "hi" in the
channel. It should respond to you. You can also add reactions to messages and the bot will send
a message using the same emoji.

Installations are kept in memory, so after a restart you need to click
**Add to Slack** again. A real app would store them in a database; see the
`installationStore` in `index.js`. It keys org-wide installations by enterprise
and everything else by workspace, so the sample also works when installed
org-wide (`org_deploy_enabled` in the manifest).

## Tests

`npm test` runs an end-to-end smoke test that drives the real Bolt receiver with
signed requests against a mock Slack API. It needs no credentials and no network,
and it runs on Node 20 and 22 in CI.

## Routes

| Path | Purpose |
|---|---|
| `/` | Redirects to the install page |
| `/slack/install` | "Add to Slack" page (served by Bolt) |
| `/slack/oauth_redirect` | OAuth callback (served by Bolt) |
| `/slack/events` | Events API request URL (served by Bolt) |
