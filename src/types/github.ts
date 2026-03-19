export interface GitHubActor {
  login: string;
  type?: string;
}

export interface GitHubInstallation {
  id: number;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  state: string;
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
    repo?: {
      full_name: string;
    } | null;
  };
  user: GitHubActor;
}

export interface PullRequestWebhookPayload {
  action: string;
  installation?: GitHubInstallation;
  repository: GitHubRepository;
  number: number;
  pull_request: PullRequestDetails;
  sender?: GitHubActor;
}

export interface IssueCommentWebhookPayload {
  action: string;
  installation?: GitHubInstallation;
  repository: GitHubRepository;
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: GitHubActor;
    author_association?: string;
  };
  sender?: GitHubActor;
}

export interface PullRequestReviewCommentWebhookPayload {
  action: string;
  installation?: GitHubInstallation;
  repository: GitHubRepository;
  pull_request: PullRequestDetails;
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: GitHubActor;
    in_reply_to_id?: number;
    author_association?: string;
  };
  sender?: GitHubActor;
}

export interface IssueComment {
  id: number;
  body: string;
  user: GitHubActor;
  created_at?: string;
  author_association?: string;
}

export interface PullRequestReviewComment {
  id: number;
  body: string;
  user: GitHubActor;
  in_reply_to_id?: number;
  created_at?: string;
  author_association?: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
