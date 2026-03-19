export interface PullRequestWebhookPayload {
  action: string;
  installation?: {
    id: number;
  };
  repository: {
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  number: number;
  pull_request: {
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
    user: {
      login: string;
    };
  };
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
