# Issues Intake

This repository is the public intake point for simple reports and feature requests.

## For people without GitHub accounts

Use the intake page in this repo. Pick the affected application, then describe the problem or the feature you want.

If the server is running in `DRY_RUN=1`, the page will tell you that it only validated the report and did not create a GitHub issue.

## For GitHub users

Use the issue forms in `.github/ISSUE_TEMPLATE/`.

## What to include

- who you are
- how to reach you
- which application is affected
- whether this is a problem or a feature request
- device, browser, and time details for problems
- exact error text or screenshots when available

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
- `GITHUB_REPOSITORY` or `ISSUE_REPO` for the public issue repo
- `PORT` for the local server port
- `HOST` for the local bind address
- `DRY_RUN=1` to validate submissions without creating GitHub issues

For PM2 on the server, `HOST` is set to `0.0.0.0` in [`ecosystem.config.cjs`](./ecosystem.config.cjs).

## Local `.env`

Start from [`.env.example`](./.env.example) and copy it to `.env`.

Suggested values for your first setup:

- `HOST=127.0.0.1` for local testing
- `PORT=3021`
- `ISSUE_REPO=deckfamilyfarm/issues`
- `GITHUB_TOKEN=` your GitHub token with access to the intake repo
- `DRY_RUN=1` while testing locally

For the server behind `issues.deckfamilyfarm.com`:

- `HOST=0.0.0.0`
- `PORT=3021` unless your reverse proxy uses a different port
- `DRY_RUN=0` or omit it entirely

If the page says the API cannot be reached, that usually means the reverse proxy or base URL is not pointing the browser to the Node server yet.

## GitHub Pages note

GitHub Pages can host the static intake page in `index.html`, but the issue-creation endpoint still has to run on a server or serverless function.
