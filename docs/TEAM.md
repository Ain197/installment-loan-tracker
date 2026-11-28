# Team split

Three members, one service each, no file owned by two people. Each member committed their own part from
their own GitHub account, on their own branch, merged through a pull request.

| Member | Service | Owns (main parts) | AWS services in their service |
|---|---|---|---|
| **Abdelrahman Mohamed** (repo owner) | Reminders, Notifications & Monitoring | `services/reminders/`, Secrets Manager loader, events, metrics, alerts, Emails page, Lender desk, deploy tooling, `infra/00-shared.sh`, `05-secrets.sh`, `40-reminders.sh` | Lambda, DynamoDB ×3, EventBridge rule + Scheduler, SQS ×2, SNS, CloudWatch metrics + alarm, IAM, Secrets Manager + KMS; Brevo API |
| **Mahmoud Tarek Zakzok** | Plan & Schedule | `services/plans/`, shared helpers (errors, validation, money, dates, app factory, DynamoDB), design system, Plans + Plan pages, `infra/20-plans.sh`, `90-frontend.sh` | API Gateway, Lambda, DynamoDB ×2, EventBridge, IAM, Secrets Manager, CloudWatch, S3 website |
| **Osman Awad** | Payments & Balance (+ Auth) | `services/payments/`, `services/auth/`, login tokens and service client, Login + Overview pages, `infra/10-auth.sh`, `30-payments.sh` | Lambda, DynamoDB (+ status index), S3 receipts, EventBridge, IAM, Secrets Manager, CloudWatch; Neon Postgres |

## 1. Run it

```bash
cd services && npm install && npm test      # 63 tests
npm run demo                                # http://localhost:3000 without Floci
```

Deploying on Floci: copy `infra/deploy.env.example` to `infra/deploy.env`, fill it in, then double-click
`deploy.cmd` (or `bash infra/deploy-all.sh`). Never commit `deploy.env`; it is in `.gitignore`.

## 2. What each member must be able to explain

**Mahmoud: Plan & Schedule**
- How a schedule is built: equal parts with the rounding cent on the last instalment; month ends (31 Jan → 28 Feb).
- Reducing-balance interest (annuity formula) versus flat interest, and why the principal always adds up exactly.
- Late fees: grace period, fixed or percentage, charged once, waived by an admin only if no part is paid.
- Payoff quote: due instalments in full, future ones without their unpaid interest.
- Status workflow ACTIVE → COMPLETED/CANCELLED, reschedule keeps paid instalments.
- Your AWS: API Gateway routes, Lambda, the two DynamoDB tables and the ownerId index, IAM policy, events you publish.

**Osman: Payments & Balance (+ Auth)**
- Oldest-first allocation (fee, then interest, then principal) and why it is always rebuilt from all valid payments.
- The approval workflow: PENDING → VERIFIED or REJECTED; why a receipt is required; withdraw; 24-hour reversal.
- Early payoff as a payment, and how it settles the plan through the Plans internal API.
- Receipts in a private S3 bucket: type check by file signature, 2 MB limit, ownership check on download.
- Login: bcrypt hashes, JWT with role, 401 vs 403, users in Neon (and the DynamoDB fallback).
- Your AWS: Lambda, DynamoDB with the status index, S3, IAM, how Payments calls Plans by Lambda Invoke.

**Abdelrahman: Reminders & Monitoring**
- The daily job: late fees (via Plans) → reminders → escalations → metrics → alerts → run history.
- Why a reminder is never sent twice (deterministic notification id + conditional write) and the catch-up rule.
- Brevo as the external API, failed emails, retries and the SQS dead-letter queue.
- CloudWatch custom metrics and the alarm on failed emails → SNS topic → SQS alerts inbox.
- Secrets Manager + KMS: what is stored where, least-privilege IAM per Lambda, rotation without logging anyone out.
- How EventBridge (rule + Scheduler) starts the Reminders Lambda in three different ways.

## 3. Demo video (5 minutes): suggested split

| Time | Who | What to show |
|---|---|---|
| 0:00–0:30 | Abdelrahman | Floci running, `deploy.cmd` / `check.cmd` all PASS, the AWS resources in Floci |
| 0:30–1:45 | Mahmoud | Create a loan with interest and a late-fee policy, its schedule and ribbon, payoff quote |
| 1:45–3:00 | Osman | Customer records a payment with a receipt → pending → lender approves → balance updates |
| 3:00–4:30 | Abdelrahman | Lender desk: run the daily job → late fee, reminder and escalation; emails page; `alerts.sh` |
| 4:30–5:00 | All | Secrets Manager (no secrets in Lambda), tests passing |
