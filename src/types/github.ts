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
  };
  sender?: GitHubActor;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
