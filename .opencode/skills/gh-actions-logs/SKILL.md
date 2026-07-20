---
name: gh-actions-logs
description: Use when the user wants to find, view, or debug GitHub Actions workflow run logs. Triggers on keywords like "action logs", "workflow logs", "CI logs", "build logs", "failed workflow", "gh run logs", "get logs from CI", "debug CI failure", or any request to inspect GitHub Actions output.
---

# GitHub Actions Logs

Use the GitHub MCP tools to find and retrieve logs from GitHub Actions workflow runs.

## Target repo

- **owner:** `hoahien7281`
- **repo:** `docker-caddy-tailscale-tinyauth`

Always use these values for `owner` and `repo` parameters. Do NOT ask the user for them.

## Workflow

1. **Identify the target run** — ask or infer from context (branch, recent commit, workflow name).
2. **List runs** — use `github_actions_list` with `method: list_workflow_runs` to find the relevant run.
3. **Get run details** — use `github_actions_get` with `method: get_workflow_run` to check status, conclusion, and timing.
4. **List jobs** — use `github_actions_list` with `method: list_workflow_jobs` to see which jobs failed.
5. **Retrieve logs** — use `github_get_job_logs` with the failing `job_id`, or `failed_only: true` with the `run_id` to get all failed job logs at once.
6. **For deeper inspection** — use `github_actions_get` with `method: get_workflow_run_logs_url` to get a direct download URL.

## Key tools

| Tool | Method | When to use |
|------|--------|-------------|
| `github_actions_list` | `list_workflow_runs` | Browse recent runs, filter by branch/status |
| `github_actions_list` | `list_workflow_jobs` | See per-job status within a run |
| `github_actions_get` | `get_workflow_run` | Run metadata (conclusion, timing, commit) |
| `github_actions_get` | `get_workflow_run_usage` | Compute time/cost per run |
| `github_get_job_logs` | — | Raw log content for a specific job or all failed jobs |
| `github_actions_get` | `get_workflow_run_logs_url` | Download URL for the full log archive |

## Tips

- Use `failed_only: true` on `github_get_job_logs` to skip successful jobs.
- If logs are too large, use `tail_lines` to get the last N lines (default 500).
- For quick triage: list runs → pick latest failed → get failed job logs → read tail.
- To re-run failed jobs, use `github_actions_run_trigger` with `method: rerun_failed_jobs`.

## Example flow

```
User: "show me why the CI failed on main"

1. github_actions_list(method: list_workflow_runs, owner: "hoahien7281", repo: "docker-caddy-tailscale-tinyauth", branch: "main", status: "completed")
2. Pick the latest failed run → github_actions_get(method: get_workflow_run, owner: "hoahien7281", repo: "docker-caddy-tailscale-tinyauth", run_id)
3. github_get_job_logs(owner: "hoahien7281", repo: "docker-caddy-tailscale-tinyauth", run_id, failed_only: true, return_content: true)
4. Summarize the failure from the log output
```
