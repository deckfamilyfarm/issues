import http from "node:http";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  displayRepositoryLabel,
  isKnownRequestType,
  isKnownRepository,
  issueLabelForRepo,
} from "./repos.js";

function loadLocalEnv(envPath) {
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(resolve(here, ".env"));
const port = Number(process.env.PORT || 3021);
const host = process.env.HOST || "127.0.0.1";
const issueRepo = process.env.ISSUE_REPO || process.env.GITHUB_REPOSITORY || "deckfamilyfarm/issues";
const githubToken = process.env.GITHUB_TOKEN || "";
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || "";
const postmarkServerToken = process.env.POSTMARK_SERVER_TOKEN || "";
const postmarkFromEmail = process.env.POSTMARK_FROM_EMAIL || "";
const postmarkReplyToEmail = process.env.POSTMARK_REPLY_TO_EMAIL || "";
const postmarkMessageStream = process.env.POSTMARK_MESSAGE_STREAM || "";
const postmarkWebhookSecret = process.env.POSTMARK_WEBHOOK_SECRET || "";
const dataDir = resolve(here, process.env.DATA_DIR || ".data");
const reporterContactsPath = resolve(dataDir, "reporter-contacts.json");
const dryRun = process.env.DRY_RUN === "1";
const humanCheckTtlMs = 10 * 60 * 1000;
const humanChallenges = new Map();
let contactStoreQueue = Promise.resolve();

const emailAllowedAuthorAssociations = new Set(
  (process.env.EMAIL_ALLOWED_AUTHOR_ASSOCIATIONS || "OWNER,MEMBER,COLLABORATOR")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean),
);
const reporterReplyMarker = "<!-- email-bridge:reporter-reply -->";
const internalCommentMarker = "<!-- email-bridge:internal -->";

if (dryRun) {
  process.stdout.write("Issue intake running in DRY_RUN mode; no GitHub issue will be created.\n");
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".yml", "text/yaml; charset=utf-8"],
  [".yaml", "text/yaml; charset=utf-8"],
]);

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload, null, 2), {
    "content-type": "application/json; charset=utf-8",
  });
}

function parseBody(req, limit = 64_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", rejectPromise);
  });
}

async function parseJson(req, limit = 64_000) {
  const text = await parseBody(req, limit);
  return text ? JSON.parse(text) : {};
}

async function serveStatic(pathname, res) {
  const path = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(here, `.${path}`));

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      send(res, 404, "Not found");
      return;
    }

    const content = await readFile(filePath);
    const type = contentTypes.get(extname(filePath)) || "application/octet-stream";
    send(res, 200, content, { "content-type": type });
  } catch {
    send(res, 404, "Not found");
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  const email = normalizeText(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("contact must be a valid email address.");
  }
  return email;
}

function requireField(value, name) {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function extractEmailAddress(value) {
  const text = normalizeText(value);
  const match = text.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (match) {
    return match[1].toLowerCase();
  }

  const bare = text.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return bare ? bare[0].toLowerCase() : "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function truncateText(value, maxLength = 60_000) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[Message truncated.]`;
}

function truncateLine(value, maxLength = 140) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function readReporterContacts() {
  try {
    const text = await readFile(reporterContactsPath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeReporterContacts(contacts) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${reporterContactsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(contacts, null, 2)}\n`, "utf8");
  await rename(tempPath, reporterContactsPath);
}

async function updateReporterContacts(mutator) {
  const next = contactStoreQueue.then(async () => {
    const contacts = await readReporterContacts();
    const result = await mutator(contacts);
    await writeReporterContacts(contacts);
    return result;
  });

  contactStoreQueue = next.catch(() => {});
  return next;
}

async function getReporterContact(issueNumber) {
  await contactStoreQueue.catch(() => {});
  const contacts = await readReporterContacts();
  return contacts[String(issueNumber)] || null;
}

function normalizeHumanAnswer(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, " ");
}

function cleanupHumanChallenges(now = Date.now()) {
  for (const [id, challenge] of humanChallenges) {
    if (challenge.expiresAt <= now) {
      humanChallenges.delete(id);
    }
  }
}

function createHumanChallenge() {
  cleanupHumanChallenges();

  const mathA = randomInt(2, 10);
  const mathB = randomInt(2, 10);
  const biggerA = randomInt(3, 10);
  const biggerB = randomInt(11, 19);
  const questions = [
    {
      question: `What is ${mathA} plus ${mathB}?`,
      answers: [String(mathA + mathB)],
    },
    {
      question: `Type the word farm.`,
      answers: ["farm"],
    },
    {
      question: `Which is bigger: ${biggerA} or ${biggerB}?`,
      answers: [String(biggerB)],
    },
    {
      question: `What is the first word in Deck Family Farm?`,
      answers: ["deck"],
    },
    {
      question: `Type the last word in Deck Family Farm.`,
      answers: ["farm"],
    },
  ];
  const selected = questions[randomInt(questions.length)];
  const id = randomUUID();

  humanChallenges.set(id, {
    answers: selected.answers.map(normalizeHumanAnswer),
    expiresAt: Date.now() + humanCheckTtlMs,
  });

  return {
    id,
    question: selected.question,
    expiresInSeconds: Math.floor(humanCheckTtlMs / 1000),
  };
}

function validateHumanCheck(id, value) {
  cleanupHumanChallenges();

  const challenge = humanChallenges.get(normalizeText(id));
  if (!challenge) {
    throw new Error("Human check expired. Please answer the new question.");
  }

  humanChallenges.delete(normalizeText(id));

  if (!challenge.answers.includes(normalizeHumanAnswer(value))) {
    throw new Error("Human check failed.");
  }
}

function escapeMd(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderIssueBody(payload) {
  const lines = [
    `## Request type`,
    payload.requestType === "problem" ? "Problem" : "Feature request",
    ``,
    `## Affected repository`,
    displayRepositoryLabel(payload.affectedRepo),
    ``,
    `## Reporter`,
    `- Name: ${payload.reporterName}`,
    `- Contact: email on file`,
  ];

  if (payload.requestType === "problem") {
    lines.push(
      ``,
      `## Problem details`,
      `- Device: ${payload.deviceType || "not provided"}`,
      `- Browser: ${payload.browser || "not provided"}`,
      `- When it happened: ${payload.happenedAt || "not provided"}`,
      `- Exact message: ${payload.errorMessage || "not provided"}`,
    );
  } else {
    lines.push(
      ``,
      `## Requested change`,
      payload.desiredOutcome || "Not provided.",
      ``,
      `## Why it matters`,
      payload.why || "Not provided.",
    );
  }

  lines.push(
    ``,
    `## Details`,
    payload.details,
  );

  if (payload.attachments) {
    lines.push(``, `## Attachments or links`, payload.attachments);
  }

  return lines.map(escapeMd).join("\n");
}

async function githubRequest(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
  });

  return response;
}

async function ensureLabel(name, color, description) {
  const check = await githubRequest(`/repos/${issueRepo}/labels/${encodeURIComponent(name)}`);
  if (check.ok) {
    return;
  }

  if (check.status !== 404) {
    const text = await check.text();
    throw new Error(`Could not inspect label "${name}": ${check.status} ${text}`);
  }

  const create = await githubRequest(`/repos/${issueRepo}/labels`, {
    method: "POST",
    body: JSON.stringify({ name, color, description }),
  });

  if (!create.ok && create.status !== 422) {
    const text = await create.text();
    throw new Error(`Could not create label "${name}": ${create.status} ${text}`);
  }
}

async function createIssue(payload) {
  const titlePrefix = payload.requestType === "problem" ? "Problem" : "Feature request";
  const title = `[${titlePrefix}] ${payload.title}`;
  const body = renderIssueBody(payload);
  const labels = [
    payload.requestType,
    issueLabelForRepo(payload.affectedRepo),
  ];

  await ensureLabel("problem", "d73a4a", "User reported a broken behavior.");
  await ensureLabel("feature-request", "0e7490", "User requested a new behavior.");
  await ensureLabel(
    issueLabelForRepo(payload.affectedRepo),
    "0969da",
    `Traffic for ${payload.affectedRepo}.`,
  );

  const response = await githubRequest(`/repos/${issueRepo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub issue creation failed: ${response.status} ${text}`);
  }

  return JSON.parse(text);
}

function headerValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || "";
}

function verifyGitHubSignature(req, rawBody) {
  if (!githubWebhookSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required for the GitHub webhook.");
  }

  const signature = headerValue(req, "x-hub-signature-256");
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", githubWebhookSecret)
    .update(rawBody)
    .digest("hex")}`;

  return timingSafeStringEqual(signature, expected);
}

function verifyPostmarkWebhook(req, url) {
  if (!postmarkWebhookSecret) {
    throw new Error("POSTMARK_WEBHOOK_SECRET is required for the Postmark webhook.");
  }

  const token =
    url.searchParams.get("token") ||
    headerValue(req, "x-postmark-webhook-secret") ||
    headerValue(req, "x-webhook-secret");

  return timingSafeStringEqual(token, postmarkWebhookSecret);
}

function assertPostmarkOutboundConfigured() {
  const missing = [];
  if (!postmarkServerToken) {
    missing.push("POSTMARK_SERVER_TOKEN");
  }
  if (!postmarkFromEmail) {
    missing.push("POSTMARK_FROM_EMAIL");
  }
  if (!postmarkReplyToEmail) {
    missing.push("POSTMARK_REPLY_TO_EMAIL");
  }

  if (missing.length) {
    throw new Error(`Postmark outbound email is not configured: ${missing.join(", ")}.`);
  }
}

function plusAddress(address, hash) {
  const email = extractEmailAddress(address);
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) {
    throw new Error("POSTMARK_REPLY_TO_EMAIL must be a valid email address.");
  }

  const local = email.slice(0, atIndex).split("+")[0];
  const domain = email.slice(atIndex + 1);
  return `${local}+${hash}@${domain}`;
}

function postmarkIssueReplyTo(issueNumber) {
  return plusAddress(postmarkReplyToEmail, String(issueNumber));
}

async function sendPostmarkEmail(message) {
  assertPostmarkOutboundConfigured();

  const payload = {
    ...message,
    MessageStream: postmarkMessageStream || undefined,
  };

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": postmarkServerToken,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Postmark send failed: ${response.status} ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function renderIssueCommentEmail(issue, comment) {
  const author = comment.user?.login || "A maintainer";
  const body = truncateText(
    normalizeText(comment.body)
      .replace(reporterReplyMarker, "")
      .replace(internalCommentMarker, ""),
  );

  return [
    `${author} replied to your request:`,
    ``,
    body,
    ``,
    `Issue: ${issue.html_url}`,
    ``,
    `Reply to this email to add a note to the issue.`,
  ].join("\n");
}

async function emailReporterForIssueComment(issue, comment, contact) {
  const subject = `Re: ${truncateLine(issue.title || `Issue #${issue.number}`)}`;

  return sendPostmarkEmail({
    From: postmarkFromEmail,
    To: contact.email,
    ReplyTo: postmarkIssueReplyTo(issue.number),
    Subject: subject,
    TextBody: renderIssueCommentEmail(issue, comment),
    Tag: "github-issue-reply",
    Headers: [
      {
        Name: "X-GitHub-Issue",
        Value: String(issue.number),
      },
    ],
  });
}

async function createIssueComment(issueNumber, body) {
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required to create issue comments.");
  }

  const response = await githubRequest(`/repos/${issueRepo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub issue comment creation failed: ${response.status} ${text}`);
  }

  return JSON.parse(text);
}

function mailboxHashFromAddress(value) {
  const email = extractEmailAddress(value);
  const local = email.split("@")[0] || "";
  const plusIndex = local.lastIndexOf("+");
  return plusIndex === -1 ? "" : local.slice(plusIndex + 1);
}

function issueNumberFromPostmarkPayload(payload) {
  const toFull = Array.isArray(payload.ToFull) ? payload.ToFull : [];
  const candidates = [
    payload.MailboxHash,
    payload.OriginalRecipient && mailboxHashFromAddress(payload.OriginalRecipient),
    payload.To && mailboxHashFromAddress(payload.To),
    ...toFull.map((address) => address.MailboxHash),
    ...toFull.map((address) => address.Email && mailboxHashFromAddress(address.Email)),
  ];

  const hash = candidates
    .map(normalizeText)
    .find((value) => /^\d+$/.test(value));

  return hash ? Number(hash) : null;
}

function inboundEmailFromPostmarkPayload(payload) {
  return extractEmailAddress(payload.FromFull?.Email || payload.From || "");
}

function inboundReplyTextFromPostmarkPayload(payload) {
  return truncateText(
    payload.StrippedTextReply ||
      payload.TextBody ||
      stripHtml(payload.HtmlBody),
  );
}

function renderReporterReplyComment(contact, replyText) {
  return [
    reporterReplyMarker,
    `Reply from ${contact.reporterName || "the reporter"} via email:`,
    ``,
    replyText,
  ].join("\n");
}

async function handleGitHubWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await parseBody(req, 256_000);
  } catch (error) {
    sendJson(res, 400, { message: error instanceof Error ? error.message : "Invalid request body." });
    return;
  }

  try {
    if (!verifyGitHubSignature(req, rawBody)) {
      sendJson(res, 401, { message: "Invalid GitHub webhook signature." });
      return;
    }

    if (headerValue(req, "x-github-event") !== "issue_comment") {
      sendJson(res, 202, { ok: true, ignored: true, reason: "not an issue_comment event" });
      return;
    }

    const payload = rawBody ? JSON.parse(rawBody) : {};
    const issue = payload.issue || {};
    const comment = payload.comment || {};
    const body = normalizeText(comment.body);

    if (payload.action !== "created") {
      sendJson(res, 202, { ok: true, ignored: true, reason: "not a created comment" });
      return;
    }

    if (issue.pull_request) {
      sendJson(res, 202, { ok: true, ignored: true, reason: "pull request comment" });
      return;
    }

    if (!issue.number || !body) {
      sendJson(res, 202, { ok: true, ignored: true, reason: "missing issue number or comment body" });
      return;
    }

    if (body.includes(reporterReplyMarker) || body.includes(internalCommentMarker)) {
      sendJson(res, 202, { ok: true, ignored: true, reason: "email bridge marker" });
      return;
    }

    const authorAssociation = normalizeText(comment.author_association).toUpperCase();
    if (!emailAllowedAuthorAssociations.has(authorAssociation)) {
      sendJson(res, 202, { ok: true, ignored: true, reason: "comment author is not allowed" });
      return;
    }

    const contact = await getReporterContact(issue.number);
    if (!contact?.email) {
      sendJson(res, 202, { ok: true, ignored: true, reason: "no reporter email on file" });
      return;
    }

    await emailReporterForIssueComment(issue, comment, contact);
    sendJson(res, 200, { ok: true, emailed: true, issueNumber: issue.number });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub webhook failed.";
    const status =
      message.includes("required for the GitHub webhook") ||
      message.includes("Postmark outbound email is not configured") ||
      message.includes("Postmark send failed")
        ? 500
        : 400;
    sendJson(res, status, { message });
  }
}

async function handlePostmarkInboundWebhook(req, res, url) {
  try {
    if (!verifyPostmarkWebhook(req, url)) {
      sendJson(res, 403, { message: "Invalid Postmark webhook token." });
      return;
    }
  } catch (error) {
    sendJson(res, 500, { message: error instanceof Error ? error.message : "Postmark webhook is not configured." });
    return;
  }

  let payload;
  try {
    payload = await parseJson(req, 1_000_000);
  } catch (error) {
    sendJson(res, 400, { message: error instanceof Error ? error.message : "Invalid Postmark JSON." });
    return;
  }

  try {
    const issueNumber = issueNumberFromPostmarkPayload(payload);
    if (!issueNumber) {
      sendJson(res, 200, { ok: true, ignored: true, reason: "missing issue mailbox hash" });
      return;
    }

    const contact = await getReporterContact(issueNumber);
    if (!contact?.email) {
      sendJson(res, 200, { ok: true, ignored: true, reason: "no reporter email on file" });
      return;
    }

    const fromEmail = inboundEmailFromPostmarkPayload(payload);
    if (!fromEmail || !timingSafeStringEqual(fromEmail, contact.email)) {
      sendJson(res, 403, { message: "Inbound email sender does not match the reporter email on file." });
      return;
    }

    const replyText = inboundReplyTextFromPostmarkPayload(payload);
    if (!replyText) {
      sendJson(res, 200, { ok: true, ignored: true, reason: "empty reply body" });
      return;
    }

    const comment = await createIssueComment(
      issueNumber,
      renderReporterReplyComment(contact, replyText),
    );

    sendJson(res, 200, {
      ok: true,
      created: true,
      issueNumber,
      commentUrl: comment.html_url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Postmark webhook failed.";
    sendJson(res, 500, { message });
  }
}

async function handleIssueSubmit(req, res) {
  let payload;
  try {
    payload = await parseJson(req);
  } catch (error) {
    sendJson(res, 400, { message: error instanceof Error ? error.message : "Invalid JSON." });
    return;
  }

  try {
    const requestType = requireField(payload.requestType, "requestType");
    const affectedRepo = requireField(payload.affectedRepo, "affectedRepo");
    const reporterName = requireField(payload.reporterName, "reporterName");
    const contact = normalizeEmail(requireField(payload.contact, "contact"));
    const title = requireField(payload.title ?? payload.summary, "title");
    const details = requireField(payload.details, "details");
    const humanCheckId = requireField(payload.humanCheckId, "humanCheckId");
    const humanCheck = requireField(payload.humanCheck, "humanCheck");

    if (!isKnownRequestType(requestType)) {
      throw new Error("requestType must be problem or feature-request.");
    }

    if (!isKnownRepository(affectedRepo)) {
      throw new Error("affectedRepo is not one of the allowed repositories.");
    }

    validateHumanCheck(humanCheckId, humanCheck);

    const normalized = {
      requestType,
      affectedRepo,
      reporterName,
      contact,
      title,
      details,
      deviceType: normalizeText(payload.deviceType),
      browser: normalizeText(payload.browser),
      happenedAt: normalizeText(payload.happenedAt),
      errorMessage: normalizeText(payload.errorMessage),
      desiredOutcome: normalizeText(payload.desiredOutcome),
      why: normalizeText(payload.why),
      attachments: normalizeText(payload.attachments),
    };

    if (dryRun) {
      sendJson(res, 200, {
        ok: true,
        dryRun: true,
        created: false,
        mode: "dry-run",
        message: "Validated locally; no GitHub issue was created.",
        issueNumber: 1,
        issueUrl: null,
        body: renderIssueBody(normalized),
      });
      return;
    }

    if (!githubToken) {
      throw new Error("GITHUB_TOKEN is required to create issues.");
    }

    const issue = await createIssue(normalized);
    await updateReporterContacts((contacts) => {
      contacts[String(issue.number)] = {
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        repository: issueRepo,
        reporterName,
        email: contact,
        requestType,
        affectedRepo,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    sendJson(res, 201, {
      ok: true,
      dryRun: false,
      created: true,
      mode: "live",
      message: "GitHub issue created.",
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      repository: issueRepo,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create issue.";
    const status = message.includes("required to create issues") || message.includes("GitHub issue creation failed")
      ? 500
      : 400;
    sendJson(res, status, {
      message,
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      ok: true,
      dryRun,
      mode: dryRun ? "dry-run" : "live",
      issueRepo,
      hasGitHubToken: Boolean(githubToken),
      hasGitHubWebhookSecret: Boolean(githubWebhookSecret),
      hasPostmarkServerToken: Boolean(postmarkServerToken),
      hasPostmarkFromEmail: Boolean(postmarkFromEmail),
      hasPostmarkReplyToEmail: Boolean(postmarkReplyToEmail),
      hasPostmarkWebhookSecret: Boolean(postmarkWebhookSecret),
      apiUrl: "/api/issues",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/human-check") {
    sendJson(res, 200, {
      ok: true,
      ...createHumanChallenge(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/issues") {
    handleIssueSubmit(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/webhooks/github") {
    handleGitHubWebhook(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/webhooks/postmark") {
    handlePostmarkInboundWebhook(req, res, url);
    return;
  }

  if (req.method === "GET") {
    serveStatic(url.pathname, res);
    return;
  }

  send(res, 405, "Method not allowed");
});

server.listen(port, host, () => {
  process.stdout.write(`Issue intake server listening on http://${host}:${port}\n`);
});
