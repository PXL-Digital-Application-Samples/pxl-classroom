# Aggressive Actions Minute Reduction Plan (Wave 8)

This plan details the architectural shift to eliminate unnecessary GitHub Actions polling, rip out the queueing system, and ensure the system consumes exactly **zero billed minutes** when there are no active assignments.

## 1. Ditching the Queue & Roster Validation
**The Problem:** The system currently queues student acceptances and processes them every 30 minutes to avoid rate limits, adding massive latency and unnecessary polling overhead.
**The Solution:** 
- Delete `process-queue.yml` entirely.
- When a student accepts the assignment (via the SPA starring the broker), synchronously provision their repository immediately.
- Remove strict roster validation prior to provisioning; any student who accepts gets a repository.
- **Handling Limits:** If 300+ students accept within the exact same hour and hit GitHub's 5,000 API/hr rate limit, the synchronous workflow will fail. The SPA will time out, displaying: *"GitHub is currently experiencing high load. Please try again in 15 minutes."* 

## 2. Daily Commit Activity Gathering
**The Problem:** `collect-activity.yml` runs every 15 minutes to fetch commits, consuming thousands of minutes a month.
**The Solution:**
- Change the activity check to run only **once a day** (nightly).
- Real-time updates are discarded in favor of post-facto tamper detection. The lecturer will have the exact commit timestamps available the next morning.

## 3. Dashboard Regeneration
**The Problem:** `regenerate-dashboard.yml` runs every 15 minutes, doing nothing most of the time.
**The Solution:**
- Rebuild the dashboard **only when data changes**:
  - Automatically trigger a rebuild at the end of the nightly activity check.
  - Automatically trigger a rebuild when a new student is provisioned.

## 4. Deleting Export Report
**The Problem:** `export-report.yml` is designed to export autograding scores. PXL Classroom does not use autograding.
**The Solution:**
- Delete `export-report.yml` and all related action code. The dashboard provides all necessary visibility.

## 5. Deadline Handling
**The Problem:** `finalize-deadline.yml` checks for passed deadlines every 5 minutes (288 runs/day). 
**The Solution:**
- Merge the deadline lock-down logic into the **single nightly run**. 
- It will run at `0 0 * * *` (midnight), wait 60 seconds to ensure synchronization, and lock down repositories for any deadlines that passed at `23:59`.
- If a deadline passes earlier in the day (e.g., `17:59`), the repos won't physically lock until midnight. However, any commits pushed between `18:00` and midnight are perfectly time-stamped by Git and will be accurately flagged as "late" on the dashboard.

## 6. Zero Minutes When Idle (Dynamic Workflow Disabling)
**The Problem:** Even with a single nightly cron, the system runs a VM every day of the year, burning minutes when no classes are active.
**The Solution:**
- We will use GitHub's native `gh workflow enable` and `gh workflow disable` commands to dynamically pause and resume the background jobs.
- When an instructor publishes a new assignment, the system will run `gh workflow enable daily-activity.yml` to turn the nightly job on.
- Every night, the job will check if there are any active projects left.
- If all deadlines have passed and there are no active projects, the job will run `gh workflow disable daily-activity.yml` on itself.
- **Impact:** When there are no active projects, the system sits completely dormant. **0 runs. 0 billed minutes.** It only wakes up and runs during active classroom projects.
