import { OTHER_REPOSITORY, REPOSITORIES, REQUEST_TYPES } from "./repos.js";

const form = document.getElementById("intake-form");
const statusEl = document.getElementById("status");
const submissionResultEl = document.getElementById("submission-result");
const submissionMessageEl = document.getElementById("submission-message");
const submissionLinkEl = document.getElementById("submission-link");
const featureRequestsLinkEl = document.getElementById("feature-requests-link");
const openIssuesLinkEl = document.getElementById("open-issues-link");
const requestTypeEl = document.getElementById("requestType");
const repoEl = document.getElementById("affectedRepo");
const apiHintEl = document.getElementById("api-hint");
const humanCheckQuestionEl = document.getElementById("human-check-question");
const humanCheckIdEl = document.getElementById("humanCheckId");
const humanCheckEl = document.getElementById("humanCheck");
const submitButtonEl = form.querySelector('button[type="submit"]');
const apiUrl =
  document.querySelector('meta[name="intake-api-url"]')?.content || "/api/issues";
const featureRequestsUrl =
  "https://github.com/deckfamilyfarm/issues/issues?q=is%3Aissue+is%3Aopen+label%3Afeature-request";
const openIssuesUrl =
  "https://github.com/deckfamilyfarm/issues/issues?q=is%3Aissue+is%3Aopen";

const sections = new Map(
  [...document.querySelectorAll("[data-section]")].map((node) => [
    node.dataset.section,
    node,
  ]),
);

for (const repo of REPOSITORIES) {
  const option = document.createElement("option");
  option.value = repo;
  option.textContent = repo;
  repoEl.append(option);
}

{
  const option = document.createElement("option");
  option.value = OTHER_REPOSITORY;
  option.textContent = "Not listed / other";
  repoEl.append(option);
}

function setSectionVisibility(requestType) {
  for (const [key, node] of sections) {
    node.classList.toggle("hidden", key !== requestType);
  }
}

function formDataToPayload(formData) {
  return {
    requestType: String(formData.get("requestType") || ""),
    affectedRepo: String(formData.get("affectedRepo") || ""),
    reporterName: String(formData.get("reporterName") || ""),
    contact: String(formData.get("contact") || ""),
    title: String(formData.get("title") || ""),
    details: String(formData.get("details") || ""),
    deviceType: String(formData.get("deviceType") || ""),
    browser: String(formData.get("browser") || ""),
    happenedAt: String(formData.get("happenedAt") || ""),
    errorMessage: String(formData.get("errorMessage") || ""),
    desiredOutcome: String(formData.get("desiredOutcome") || ""),
    why: String(formData.get("why") || ""),
    attachments: String(formData.get("attachments") || ""),
    humanCheckId: String(formData.get("humanCheckId") || ""),
    humanCheck: String(formData.get("humanCheck") || ""),
  };
}

function resetRepositorySelection() {
  repoEl.value = "";
}

function showSubmissionResult(message, url) {
  if (!submissionResultEl || !submissionMessageEl || !submissionLinkEl) {
    return;
  }

  submissionMessageEl.textContent = message;

  if (url) {
    submissionLinkEl.href = url;
    submissionLinkEl.classList.remove("hidden");
  } else {
    submissionLinkEl.classList.add("hidden");
  }

  submissionResultEl.classList.remove("hidden");
  submissionResultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

requestTypeEl.addEventListener("change", (event) => {
  setSectionVisibility(event.target.value);
});

setSectionVisibility(requestTypeEl.value);
resetRepositorySelection();

if (featureRequestsLinkEl) {
  featureRequestsLinkEl.href = featureRequestsUrl;
}

if (openIssuesLinkEl) {
  openIssuesLinkEl.href = openIssuesUrl;
}

async function loadHumanCheck() {
  if (!humanCheckQuestionEl || !humanCheckIdEl || !humanCheckEl) {
    return;
  }

  humanCheckQuestionEl.textContent = "Loading...";
  humanCheckIdEl.value = "";
  humanCheckEl.value = "";
  if (submitButtonEl) {
    submitButtonEl.disabled = true;
  }

  try {
    const response = await fetch("/api/human-check", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.json();
    humanCheckQuestionEl.textContent = body.question || "Human check unavailable";
    humanCheckIdEl.value = body.id || "";
    if (submitButtonEl) {
      submitButtonEl.disabled = !body.id;
    }
  } catch {
    humanCheckQuestionEl.textContent = "Question unavailable";
    if (submitButtonEl) {
      submitButtonEl.disabled = true;
    }
  }
}

async function loadApiStatus() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const config = await response.json();
    if (apiHintEl) {
      apiHintEl.textContent = config.dryRun
        ? "Server is in dry-run mode. Submissions will be validated but no GitHub issue will be created."
        : "Server is live. Submissions will create GitHub issues.";
    }
  } catch {
    if (apiHintEl) {
      apiHintEl.textContent =
        "Could not reach the intake API. If this page is hosted without the server or reverse proxy, submissions cannot be created yet.";
    }
  }
}

loadApiStatus();
loadHumanCheck();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "Sending...";

  const payload = formDataToPayload(new FormData(form));

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : { message: (await response.text()).slice(0, 500) };

    if (!response.ok) {
      throw new Error(
        body.message ||
          `The report could not be sent (HTTP ${response.status}).`,
      );
    }

    form.reset();
    setSectionVisibility(requestTypeEl.value);
    resetRepositorySelection();
    loadHumanCheck();

    if (body.dryRun || body.mode === "dry-run") {
      statusEl.textContent =
        "Validated locally. No GitHub issue was created because the server is in dry-run mode.";
      showSubmissionResult("Validated locally. No GitHub issue was created.", null);
      return;
    }

    const link = body.issueUrl ? ` Issue #${body.issueNumber}` : "";
    statusEl.textContent = `Created successfully.${link}`;
    showSubmissionResult(
      "Your request was submitted successfully.",
      body.issueUrl || null,
    );
  } catch (error) {
    if (error instanceof TypeError) {
      statusEl.textContent =
        "Could not reach the intake API. Check the reverse proxy or the server URL.";
      if (submissionResultEl) {
        submissionResultEl.classList.add("hidden");
      }
      return;
    }

    statusEl.textContent =
      error instanceof Error ? error.message : "Send failed.";
    if (error instanceof Error && error.message.includes("Human check")) {
      loadHumanCheck();
    }
    if (submissionResultEl) {
      submissionResultEl.classList.add("hidden");
    }
  }
});

const titleNode = document.querySelector("title");
if (titleNode && REQUEST_TYPES.length) {
  titleNode.textContent = "Issue Intake";
}
