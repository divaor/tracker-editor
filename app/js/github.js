// GitHub REST client for the data repo. Reads single files through the
// Contents API and writes many files in one commit through the Git Data API
// (trees, commits, refs), so a sync of dozens of files is one commit.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value) {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function describeError(status, data, headers) {
  const detail = data?.message ? ` GitHub says: “${data.message}”.` : '';
  switch (status) {
    case 401:
      return 'GitHub rejected the token (401). Check that it was copied correctly and has not expired.';
    case 403:
      if (headers.get('x-ratelimit-remaining') === '0') return 'GitHub API rate limit reached. Sync will retry later.';
      return `Permission denied (403). The token needs “Contents: Read and write” access to this repository.${detail}`;
    case 404:
      return 'Not found (404). Check the owner, repository and branch, and that the token has access to that repository.';
    case 409:
      return `Conflict (409).${detail}`;
    case 422:
      return `GitHub refused the change (422).${detail}`;
    default:
      return `GitHub error ${status}.${detail}`;
  }
}

// `cacheMode` and `userAgent` differ by runtime: browsers need no-store (the
// API sends max-age=60 and a cached read would hand back a stale sha) and
// refuse a custom User-Agent; servers need a User-Agent for GitHub.
export function createGitHubClient({
  token,
  owner,
  repo,
  fetchImpl = globalThis.fetch.bind(globalThis),
  apiBase = 'https://api.github.com',
  cacheMode = 'no-store',
  userAgent = '',
}) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function request(method, path, { body, query } = {}) {
    const url = new URL(apiBase + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value) url.searchParams.set(key, value);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (userAgent) headers['User-Agent'] = userAgent;
    const init = { method, headers, body: body ? JSON.stringify(body) : undefined };
    if (cacheMode) init.cache = cacheMode;
    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch {
      throw new GitHubError('Could not reach GitHub. Check your internet connection.', 0);
    }
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new GitHubError(describeError(res.status, data, res.headers), res.status);
    return data;
  }

  const client = {
    getRepo() {
      return request('GET', repoPath);
    },

    /** Commit sha at the tip of a branch, or null when the branch (or the whole repo) is empty. */
    async getBranchHead(branch) {
      try {
        const ref = await request('GET', `${repoPath}/git/ref/heads/${encodePath(branch)}`);
        return ref?.object?.sha ?? null;
      } catch (err) {
        if (err.status === 404 || err.status === 409) return null;
        throw err;
      }
    },

    async getCommitTree(commitSha) {
      const commit = await request('GET', `${repoPath}/git/commits/${commitSha}`);
      return commit.tree.sha;
    },

    /** Every file at a ref (a branch, a commit, or nothing: the default branch): [{ path, sha }]; empty for an empty repo. */
    async listTree(ref) {
      const commit = (await client.getBranchHead(ref || (await client.getRepo()).default_branch)) ?? (ref || null);
      if (!commit) return [];
      const tree = await request('GET', `${repoPath}/git/trees/${await client.getCommitTree(commit)}`, { query: { recursive: '1' } });
      return (tree?.tree ?? []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }));
    },

    /** { sha, text } of a file at a ref (branch or commit), or null when it does not exist. */
    /** Commits that touched `path` (a file or a folder), newest first: [{ sha, message, date }]. */
    async listCommits({ path: filePath, branch, perPage = 50 }) {
      const list = await request('GET', `${repoPath}/commits`, { query: { path: filePath, sha: branch || undefined, per_page: perPage } });
      return (list ?? []).map((c) => ({ sha: c.sha, message: c.commit?.message ?? '', date: c.commit?.committer?.date ?? c.commit?.author?.date ?? '' }));
    },

    /** The entries of a folder at `ref`: [{ name, path, sha, type }], or null when it does not exist there. */
    async listDir(dirPath, ref) {
      let data;
      try {
        data = await request('GET', `${repoPath}/contents/${encodePath(dirPath)}`, { query: { ref } });
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      return Array.isArray(data) ? data.map((e) => ({ name: e.name, path: e.path, sha: e.sha, type: e.type })) : null;
    },

    async getFile(filePath, ref) {
      let data;
      try {
        data = await request('GET', `${repoPath}/contents/${encodePath(filePath)}`, { query: { ref } });
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      if (Array.isArray(data) || data?.type !== 'file') throw new GitHubError(`“${filePath}” is a folder, not a file.`, 400);
      let content = data.content;
      // Files over 1 MB come back without inline content; the blob API has them.
      if (!content && data.size > 0) content = (await request('GET', `${repoPath}/git/blobs/${data.sha}`)).content;
      return { sha: data.sha, text: decodeBase64(content ?? '') };
    },

    async getBlobText(sha) {
      const blob = await request('GET', `${repoPath}/git/blobs/${sha}`);
      return blob.encoding === 'base64' ? decodeBase64(blob.content ?? '') : (blob.content ?? '');
    },

    /**
     * Creates a tree from `baseTree` plus `changes`: { path, content } writes a
     * file, { path, sha } points a path at an existing blob, { path, sha: null } deletes it.
     */
    async createTree(baseTree, changes) {
      const tree = changes.map(({ path, content, sha }) =>
        content !== undefined ? { path, mode: '100644', type: 'blob', content } : { path, mode: '100644', type: 'blob', sha },
      );
      const data = await request('POST', `${repoPath}/git/trees`, { body: { base_tree: baseTree, tree } });
      return data.sha;
    },

    async createCommit(message, treeSha, parents) {
      const data = await request('POST', `${repoPath}/git/commits`, { body: { message, tree: treeSha, parents } });
      return data.sha;
    },

    /** Moves the branch to `commitSha`; fails with 422 when someone else committed in between. */
    updateBranch(branch, commitSha) {
      return request('PATCH', `${repoPath}/git/refs/heads/${encodePath(branch)}`, { body: { sha: commitSha, force: false } });
    },

    createBranch(branch, commitSha) {
      return request('POST', `${repoPath}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commitSha } });
    },

    /** Creates or replaces one file through the Contents API (used to start an empty repo). */
    async putFile(filePath, { text, sha, branch, message }) {
      const body = { message, content: encodeBase64(text) };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const data = await request('PUT', `${repoPath}/contents/${encodePath(filePath)}`, { body });
      return { sha: data?.content?.sha ?? null, commit: data?.commit?.sha ?? null };
    },
  };
  return client;
}
