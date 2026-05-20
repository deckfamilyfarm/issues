import http from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
const dryRun = process.env.DRY_RUN === "1";
const humanCheckTtlMs = 10 * 60 * 1000;
const humanChallenges = new Map();

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

function parseJson(req, limit = 64_000) {
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
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise(text ? JSON.parse(text) : {});
      } catch (error) {
        rejectPromise(error);
      }
    });

    req.on("error", rejectPromise);
  });
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

function requireField(value, name) {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
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
    `- Contact: ${payload.contact}`,
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
  const title = `[${titlePrefix}] ${payload.summary}`;
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
    const contact = requireField(payload.contact, "contact");
    const summary = requireField(payload.summary, "summary");
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
      summary,
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

  if (req.method === "GET") {
    serveStatic(url.pathname, res);
    return;
  }

  send(res, 405, "Method not allowed");
});

server.listen(port, host, () => {
  process.stdout.write(`Issue intake server listening on http://${host}:${port}\n`);
});
