# /app

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.14. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.


## GitHub App Integration

To use the GitHub App Integration to automatically trigger runs on Push and PR events:

1. Create a GitHub App in your GitHub organization settings.
2. Ensure you have the following permissions:
   - Commit statuses: Read and write
   - Contents: Read-only
   - Metadata: Read-only
   - Pull requests: Read-only
3. Subscribe to the `Push` and `Pull Request` webhook events.
4. Set the Webhook URL to your Terrence instance: `https://<your-instance>/api/webhooks/github`
5. Provide a webhook secret.
6. Install the App on your Organization or Repositories.
7. Configure the following environment variables in your Terrence container:
   - `GITHUB_APP_ID`: The App ID from your GitHub App settings.
   - `GITHUB_APP_PRIVATE_KEY`: The RSA private key generated for your GitHub App. (Replace real newlines with `\n`)
   - `GITHUB_WEBHOOK_SECRET`: The webhook secret you configured in GitHub.
