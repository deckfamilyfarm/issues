export const REPOSITORIES = [
  "timesheets",
  "accounting-reports",
  "backups",
  "csa-store",
  "dashboards",
  "dff-workflow-builder",
  "farm-brand-tests",
  "ffcsa_scripts",
  "herdlist",
  "layers",
  "non-profit",
];

export const OTHER_REPOSITORY = "not-listed";
export const OTHER_REPOSITORY_LABEL = "Not listed / other";

export const REQUEST_TYPES = [
  { value: "problem", label: "Problem" },
  { value: "feature-request", label: "Feature request" },
];

export function isKnownRepository(value) {
  return REPOSITORIES.includes(value) || value === OTHER_REPOSITORY;
}

export function isKnownRequestType(value) {
  return REQUEST_TYPES.some((item) => item.value === value);
}

export function issueLabelForRepo(repo) {
  return `repo-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export function displayRepositoryLabel(repo) {
  return repo === OTHER_REPOSITORY ? OTHER_REPOSITORY_LABEL : repo;
}

export function issueLabelForType(type) {
  return type;
}
