# Installment & Loan Tracker

Record instalment plans (total amount, schedule, paid instalments), get email reminders before due
dates, and see the remaining balance of every plan. Cloud Computing group project, deployed on
**Floci** (local AWS emulator) with **Neon Postgres** and the **Brevo** email API.

- **Frontend:** HTML, CSS and JavaScript (no framework), hosted in an S3 bucket
- **Backend:** Node.js + Express, one Lambda function per service, behind one API Gateway HTTP API
- **Data:** DynamoDB (plans, instalments, payments, reminders, notifications), S3 (receipts), Neon (users)
- **Events:** EventBridge bus + rule, EventBridge Scheduler (daily job), SQS (failed emails, alerts inbox)
- **Security and operations:** Secrets Manager + KMS (every secret), IAM least privilege per service,
  CloudWatch Logs, custom metrics and an alarm, SNS alerts topic for the lender

**Business features:** loans with interest (reducing-balance or flat) and a principal/interest split
per instalment; late-fee policies with a grace period, charged by the daily job (admin can waive);
early payoff with a quote that waives future interest; customer payments wait for the lender's
approval (receipt required); reminders before due dates, overdue alerts, and escalation of instalments
14+ days late to the lender.

```
Browser ──> S3 website (loan-tracker-web)
   │
   └─HTTPS/JSON + login token──> API Gateway (loan-tracker-http-api)
                                   ├─ /api/auth, /api/users      -> Lambda loan-tracker-auth      -> Neon users
                                   ├─ /api/plans...              -> Lambda loan-tracker-plans     -> DynamoDB LoanPlans, LoanInstalments
                                   ├─ /api/.../payments, balance -> Lambda loan-tracker-payments  -> DynamoDB LoanPayments, S3 receipts
                                   └─ reminders, notifications   -> Lambda loan-tracker-reminders -> DynamoDB rules + log, Brevo email
Plans/Payments ──events──> EventBridge bus ──rule──> Reminders      Scheduler (daily) ──> Reminders
Payments ──Lambda invoke──> Plans (internal API)      Reminders ──Lambda invoke──> Plans
```

## Who owns what

| Owner | Service | Code | Deploy script | AWS services |
|---|---|---|---|---|
| mahmoud | Plan & Schedule: interest, late fees, payoff quote | `services/plans/`, `frontend/plans.html`, `js/plans.js` | `infra/20-plans.sh` | API Gateway, Lambda, DynamoDB ×2, IAM, EventBridge, Secrets Manager, CloudWatch |
| othman | Payments & Balance: approval workflow, payoff, receipts | `services/payments/`, payment parts of `plan.html`, `js/dashboard.js` | `infra/30-payments.sh` | Lambda, DynamoDB (+ status index), S3, IAM, EventBridge, Secrets Manager, CloudWatch |
| abdelrahman | Reminders, Notifications & Monitoring | `services/reminders/`, `notifications.html`, `admin.html` | `infra/40-reminders.sh` | Lambda, DynamoDB ×3, EventBridge rule + Scheduler, SQS ×2, SNS, CloudWatch metrics + alarm, IAM, Secrets Manager + Brevo API |
| Group | Auth, shared code, secrets, website | `services/auth/`, `services/shared/`, `frontend/js/api.js, ui.js` | `infra/00-shared.sh`, `05-secrets.sh`, `10-auth.sh`, `90-frontend.sh` | S3 website, KMS, Secrets Manager, Neon |

Each service has the same layers: `app.js` (routes + validation) → `*Service.js` (business rules)
→ `repository.js` (DynamoDB). Pure rules that are easy to test are in their own files:
`plans/schedule.js`, `payments/allocation.js`, `reminders/reminderLogic.js`.

## Each member's part

**mahmoud: Plan & Schedule**
- Creates, searches, edits and cancels instalment plans and loans.
- Builds the schedule (weekly, every 2 weeks or monthly) with reducing-balance or flat interest.
- Applies late fees after a grace period (admin can waive them) and gives the early-payoff quote.
- Plan status rules: ACTIVE, COMPLETED or CANCELLED.

**othman: Payments & Balance**
- Records payments with a receipt (private S3); customer payments wait for the lender's approval.
- Applies money oldest instalment first: fee, then interest, then principal.
- Lender approves or rejects; customer can withdraw a pending payment; admin can reverse within 24 hours.
- Early payoff, remaining balance per plan and the dashboard summary.

**abdelrahman: Reminders, Notifications & Monitoring**
- Daily job: late fees, reminders before due dates, overdue alerts and escalation of instalments 14+ days late.
- Sends the emails through the Brevo API, keeps a log and retries failed emails.
- Reminder rule per plan, run history and the lender's monitoring page (CloudWatch metrics, alarm, SNS alerts).
