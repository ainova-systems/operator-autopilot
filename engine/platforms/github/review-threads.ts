import type { Octokit } from "@octokit/rest";
import type { Comment, ReviewThread } from "@operator/core";

/**
 * GitHub review-thread helpers split out of {@link GitHubVCS} so the adapter
 * file stays focused on the provider-neutral `VCSPlatform` surface. These back
 * the pr-feedback "answer every inline comment" path:
 *
 *   - {@link fetchReviewThreads}   — list a PR's resolvable review threads with
 *     their resolved state and root-author type (GraphQL `reviewThreads`).
 *   - {@link replyToReviewThread}  — post a threaded reply carrying the agent's
 *     per-comment disposition note.
 *   - {@link resolveReviewThread}  — mark a bot-authored thread resolved once
 *     the note is posted.
 *
 * The REST API (`pulls.listReviewComments`) exposes neither the thread node id
 * required to reply/resolve nor the `isResolved` flag, so the whole surface is
 * GraphQL. Reply + resolve are keyed by the thread node id, so a single handle
 * drives both — no REST comment-id juggling.
 */

/** Page size for the reviewThreads connection — threads per PR rarely exceed this. */
const THREADS_PAGE_SIZE = 100;
/** Comments fetched per thread — enough to map every comment id to its thread. */
const COMMENTS_PER_THREAD = 100;

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: ${THREADS_PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: ${COMMENTS_PER_THREAD}) {
              nodes {
                databaseId
                body
                path
                createdAt
                updatedAt
                authorAssociation
                author { login __typename }
              }
            }
          }
        }
      }
    }
  }
`;

const ADD_THREAD_REPLY_MUTATION = `
  mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(
      input: { pullRequestReviewThreadId: $threadId, body: $body }
    ) {
      comment { id }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

interface GhGraphqlAuthor {
  login?: string | null;
  __typename?: string | null;
}

interface GhGraphqlReviewComment {
  databaseId?: number | null;
  body?: string | null;
  path?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  authorAssociation?: string | null;
  author?: GhGraphqlAuthor | null;
}

interface GhReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: GhGraphqlReviewComment[] };
}

interface ReviewThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GhReviewThreadNode[];
      };
    } | null;
  } | null;
}

/**
 * List every review thread on a PR, following GraphQL pagination. Returns an
 * empty array when the PR carries no review threads (or GraphQL reports no
 * pull request). Throws on transport / auth errors — the caller decides
 * whether to degrade (the selector treats a failure as "no threads").
 */
export async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const data: ReviewThreadsResponse = await octokit.graphql<ReviewThreadsResponse>(
      REVIEW_THREADS_QUERY,
      { owner, repo, number: prNumber, cursor },
    );
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    for (const node of connection.nodes) {
      threads.push(mapReviewThread(node));
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

/** Post a reply inside the given review thread. */
export async function replyToReviewThread(
  octokit: Octokit,
  threadId: string,
  body: string,
): Promise<void> {
  await octokit.graphql(ADD_THREAD_REPLY_MUTATION, { threadId, body });
}

/** Mark the given review thread resolved. */
export async function resolveReviewThread(
  octokit: Octokit,
  threadId: string,
): Promise<void> {
  await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
}

function mapReviewThread(node: GhReviewThreadNode): ReviewThread {
  const comments = node.comments.nodes.map(mapGraphqlReviewComment);
  return {
    id: node.id,
    isResolved: node.isResolved,
    comments,
    authorType: comments[0]?.authorType,
  };
}

function mapGraphqlReviewComment(c: GhGraphqlReviewComment): Comment {
  return {
    id: c.databaseId != null ? String(c.databaseId) : "",
    author: c.author?.login ?? "unknown",
    body: c.body ?? "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? undefined,
    path: c.path ?? undefined,
    authorAssociation: c.authorAssociation ?? undefined,
    authorType: mapAuthorTypename(c.author?.__typename),
  };
}

/** GraphQL `Actor.__typename` → the neutral author-type flag. */
function mapAuthorTypename(typename?: string | null): "User" | "Bot" | undefined {
  if (typename === "Bot") return "Bot";
  if (typename === "User") return "User";
  return undefined;
}
