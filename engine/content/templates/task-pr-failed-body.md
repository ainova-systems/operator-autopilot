## ❌ Task Failed: {TASK_ID}

**Status**: Failed after {MAX_RETRIES} attempts

### Task Details
See task file in `.operator/data/tasks/{TASK_ID}.md` for full task description.

### Failure Reason
{FAILURE_REASON}

### What was attempted
The agent made {MAX_RETRIES} attempts to complete this task but could not pass verification or review.
See the PR comments below for a detailed failure analysis.

### Next Steps
- Review the failure analysis in the PR comments
- Review the changes made by the agent
- Either fix remaining issues manually or close this PR
- Remove `ai:failed` label and comment with fixes to trigger AI review

---
*Automated by AI Automation Pipeline*
