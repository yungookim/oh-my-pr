export function getRepoHref(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return `https://github.com/${repo}`;
  }

  const [owner, name] = parts;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
