# Rewards V1

Rewards uses the existing household API, D1 binding, revision/conflict handling, and responsive components. Household sessions now protect all private routes; see [household access](household-access.md). Member choice remains separate from device authentication.

## Setup and migration

`0005_rewards.sql` adds `chores.stars` (integer, 0–1,000, default 0) and the reward tables below. It does not rewrite existing records or award historical completions. Migrations 0001–0004 remain unchanged. There are no automatically seeded rewards or balances. Browser tests deliberately create illustrative rewards in their isolated test database.

Apply locally with `pnpm db:migrate:local`. The existing GitHub → Cloudflare deployment command (`pnpm deploy`) applies pending remote migrations before publishing the Worker. Do not apply old SQL files manually or reset the production database.

The household owner must configure **`REWARDS_OPERATOR_PIN` as a Worker secret**, at least 8 characters (prefer a randomly chosen PIN or longer passphrase), in Cloudflare's Worker **Settings → Variables and Secrets**. Do not put it in `wrangler.jsonc`, GitHub, frontend environment variables, or source code. The Cloudflare [secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/) covers this configuration. For local development, put the secret in a gitignored `.dev.vars` file. No new binding is required.

Without that secret, viewing Rewards and existing chore behavior work, but management and star-value configuration fail closed with a setup message. Once configured, open Rewards → Manage rewards → Unlock operator controls, create household rewards, and edit chores to assign star values.

## Operator access

The PIN protects reward creation/editing/deletion, approval/decline, manual adjustments, and creating/editing/deleting paid chores. The Worker enforces this on every privileged mutation. Completing chores and requesting/redeeming eligible rewards retain the application's shared-household access model. A member selection is a household choice, not authenticated proof of identity.

Unlocking issues a random token valid for 15 minutes. Only a hash bound to the configured PIN is stored in D1; the browser holds the token in memory, never local storage or a cookie. Reloading or locking clears browser access. One operator session is active per household; unlocking another device replaces the previous session. Changing the PIN invalidates existing sessions. Tokens are checked server-side, including their expiration, and bound to the authenticated household session that unlocked them. Household revocation/logout/credential changes invalidate that access.

The unlock endpoint allows five attempts per household per fixed 15-minute window. A blocked attempt performs no further row update. This deliberately bounds PIN guessing and database writes; a household sharing the public URL may need to wait after repeated attempts. Household reads do not access or expose PIN/session records. Existing same-origin/JSON guards also apply. The Google admin key and credentials are unrelated and remain server-only.

## Data and balance history

- `rewards`: name, description, predefined emoji, integer cost (1–100,000), active/reusable/approval flags, creation/update timestamps.
- `reward_members`: selected-member eligibility. No rows means everyone. Household-scoped foreign keys prevent foreign household references.
- `reward_redemptions`: member, reward, quoted name/cost, one-time flag, pending/redeemed/declined status and timestamps. The quote remains stable if a reward's current cost changes.
- `chore_star_awards`: retained completion-cycle identity, chore occurrence date, member, amount, optional reversal timestamp.
- `star_transactions`: append-style signed amounts, reason/type, member, chore/completion/reward/redemption references, timestamp. There is no API to edit or delete ledger entries.

A balance is the sum of that member's ledger amounts. No stored balance needs repairing or updating on reads. Member/chore/reward foreign keys retain history. Members with reward history cannot be deleted. Rewards with requests must be deactivated instead of deleted; paid chores with award history must be ended by changing their repeat-until date rather than deleted. Reward repeatability cannot change after requests exist; create another reward instead. Names/reasons on transactions and quoted redemptions preserve understandable activity after later edits.

## Completing and undoing chores

Each existing chore occurrence remains a single household checkbox. Zero-star chores work as before. Paid chores assigned to one member award that member automatically; shared/Everyone chores ask who completed them. The member must belong to this household and be eligible for that chore.

Completion, award identity, ledger entry, receipt and revision increment commit in one D1 batch. Duplicate completion does not award again. Daily/weekly/etc. occurrences can each earn their configured award. Undo writes a compensating negative entry using the original member and amount, then marks that award reversed. Completing again creates a new cycle; its net balance is correct because the earlier cycle was reversed.

Undo is rejected if its reversal would make the member's balance negative (for example, the stars were spent already). The checkbox and history remain intact. An operator can restore stars through a reasoned manual adjustment before retrying. Editing a zero-star chore to pay stars does not retroactively reward existing checked occurrences.

## Redemption and approvals

Immediate redemption checks active state, eligibility, previous one-time use, pending requests, and sufficient balance, then atomically creates the redemption and negative ledger entry. The UI asks for confirmation and disables duplicate submits.

Approval-required rewards create a pending request **without spending or reserving stars**. An operator can approve or decline. Approval rechecks current balance, active state, eligibility, and one-time availability, then atomically deducts the quoted cost and resolves the request. An insufficient balance leaves the request pending with an error. Decline resolves the request without a ledger deduction. Only one pending request per member/reward is allowed. One-time rewards allow one successful redemption per member; reusable rewards permit later, deliberate requests.

Manual positive/negative adjustments require a nonempty reason and confirmation. A negative adjustment cannot overdraw the balance.

## Concurrency, retries and D1 usage

Financial commands are submitted separately and validated against one confirmed household revision. All writes are gated by that revision and the existing mutation receipt in an atomic [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). A concurrent mutation that changes the revision makes the entire stale command a no-op/conflict. This covers balance checks as well as eligibility, award values, and approval state. Failed statements roll back the whole batch. No other API path writes the ledger.

Mutation IDs/fingerprints make network retries safe. Redemption IDs also prevent replay under a new mutation ID. Unique indexes protect pending/one-time redemptions, active chore occurrence awards, and one transaction per award/type or redemption. The client uses the existing retry banner for uncertain saves, preserves confirmed balances, and keeps chore checkbox updates optimistic with reconciliation on failure.

Normal household loads/refetches perform **zero writes**. A mutation touches only the affected records plus receipt/revision. Eligibility updates add/remove only changed member links. Unchanged reward fields are not rewritten; there are no scheduled reward jobs, persisted balance recalculations, new polling loops or automatic seeds. The full ledger is currently fetched with household state for this small household application; the page shows six recent entries per member with an expandable history. If years of history make reads large, add server-side pagination and aggregate reads without changing the ledger model.

## Interface and validation

Rewards reuses the sidebar, family avatars, pastel cards and modal controls. Phones show Home, Calendar, Chores, Rewards and More; More exposes Meals and Lists. Member summaries scroll horizontally on phones, rewards use two columns (one below 360px), and Home adds a small balance card. Earn more stars links to the existing Chores workflow.

Run `pnpm format:check`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`. Rewards tests use real local D1 for migrations, atomic rollback, races, retries, history, permissions, PIN limits, isolation and zero-write reads. Browser tests cover locked management, edits/adjustments, approvals, paid chores/undo, lost responses, responsive navigation, and screenshots at desktop, iPad landscape/portrait, 390px and 320px.
