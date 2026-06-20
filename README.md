# Issues Intake

This repository is the public intake point for simple reports and feature requests.

## For people without GitHub accounts

Use the intake page in this repo. Pick the affected application, then describe the problem or the feature you want.

If the server is running in `DRY_RUN=1`, the page will tell you that it only validated the report and did not create a GitHub issue.

## For GitHub users

Use the issue forms in `.github/ISSUE_TEMPLATE/`.

## What to include

- who you are
- your email address
- which application is affected
- whether this is a problem or a feature request
- device, browser, and time details for problems
- exact error text or screenshots when available

## Email reply bridge

The intake server can bridge GitHub issue comments to reporters who do not have
GitHub accounts:

1. A reporter submits the form with their email address.
2. The server creates a GitHub issue and stores the reporter email privately in
   `.data/reporter-contacts.json`.
3. A staff member comments on the GitHub issue.
4. A GitHub `issue_comment` webhook calls `/api/webhooks/github`.
5. The server emails the comment to the reporter through Postmark.
6. The reporter replies to the email.
7. A Postmark inbound webhook calls `/api/webhooks/postmark`.
8. The server posts the email reply back to the GitHub issue.

New intake issues show `Contact: email on file` instead of publishing the
reporter's email address in the public GitHub issue.

## Local run

```bash
npm start
```

## PM2 deploy

This repo is set up to match the same PM2 pattern as the sibling apps in this server.

```bash
./start.sh
```

## Environment

The intake server reads:

- `GITHUB_TOKEN` for creating issues
- `GITHUB_WEBHOOK_SECRET` for verifying GitHub comment webhooks
- `GITHUB_REPOSITORY` or `ISSUE_REPO` for the public issue repo
- `PORT` for the local server port
- `HOST` for the local bind address
- `DATA_DIR` for private local reporter contact storage
- `POSTMARK_SERVER_TOKEN` for sending reporter emails
- `POSTMARK_FROM_EMAIL` for the verified sender address
- `POSTMARK_REPLY_TO_EMAIL` for the Postmark inbound address used for replies
- `POSTMARK_WEBHOOK_SECRET` for authorizing Postmark inbound webhooks
- `POSTMARK_MESSAGE_STREAM` for the outbound Postmark stream, usually `outbound`
- `EMAIL_ALLOWED_AUTHOR_ASSOCIATIONS` to control which GitHub comment authors
  can trigger reporter emails, defaulting to `OWNER,MEMBER,COLLABORATOR`
- `DRY_RUN=1` to validate submissions without creating GitHub issues

For PM2 on the server, `HOST` is set to `0.0.0.0` in [`ecosystem.config.cjs`](./ecosystem.config.cjs).

## Local `.env`

Start from [`.env.example`](./.env.example) and copy it to `.env`.

Suggested values for your first setup:

- `HOST=127.0.0.1` for local testing
- `PORT=3021`
- `ISSUE_REPO=deckfamilyfarm/issues`
- `GITHUB_TOKEN=` your GitHub token with access to the intake repo
- `GITHUB_WEBHOOK_SECRET=` a random secret copied into the GitHub webhook
- `DATA_DIR=.data`
- `POSTMARK_SERVER_TOKEN=` your Postmark server token
- `POSTMARK_FROM_EMAIL=` your verified sender, such as `Deck Family Farm <issues@example.com>`
- `POSTMARK_REPLY_TO_EMAIL=` your Postmark inbound address, such as `abc123@inbound.postmarkapp.com`
- `POSTMARK_WEBHOOK_SECRET=` a random secret for the Postmark inbound webhook URL
- `DRY_RUN=1` while testing locally

For the server behind `issues.deckfamilyfarm.com`:

- `HOST=0.0.0.0`
- `PORT=3021` unless your reverse proxy uses a different port
- `DRY_RUN=0` or omit it entirely

## Webhook setup

In GitHub, add a repository webhook:

- Payload URL: `https://issues.deckfamilyfarm.com/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: issue comments

In Postmark, configure inbound processing:

- Set `POSTMARK_REPLY_TO_EMAIL` to the inbound address Postmark gives you.
- Set the inbound webhook URL to
  `https://issues.deckfamilyfarm.com/api/webhooks/postmark?token=<POSTMARK_WEBHOOK_SECRET>`.
- The app uses plus addressing automatically, so issue `123` receives replies at
  `local+123@domain`.

If the page says the API cannot be reached, that usually means the reverse proxy or base URL is not pointing the browser to the Node server yet.

## GitHub Pages note

GitHub Pages can host the static intake page in `index.html`, but the issue-creation endpoint still has to run on a server or serverless function.
