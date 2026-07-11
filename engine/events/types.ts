/**
 * Event type constants for the Operator event bus.
 *
 * Grouped by SDLC stage. Used with EventBus.emit() / EventBus.on().
 */

// ── Lifecycle ───────────────────────────────────────────────────────────
export const ENGINE_STARTED = "engine.started";
export const ENGINE_STOPPED = "engine.stopped";
export const PROJECT_STARTED = "project.started";
export const PROJECT_COMPLETED = "project.completed";

// ── Pipeline ────────────────────────────────────────────────────────────
export const PIPELINE_STARTED = "pipeline.started";
export const PIPELINE_COMPLETED = "pipeline.completed";
export const PIPELINE_FAILED = "pipeline.failed";
export const STAGE_STARTED = "stage.started";
export const STAGE_COMPLETED = "stage.completed";
export const STAGE_SKIPPED = "stage.skipped";

// ── Research (DISCOVER) ─────────────────────────────────────────────────
export const RESEARCH_STARTED = "research.started";
export const RESEARCH_COMPLETED = "research.completed";
export const FINDING_CREATED = "finding.created";

// ── Finding (PLAN) ──────────────────────────────────────────────────────
export const FINDING_SELECTED = "finding.selected";
export const FINDING_PLANNED = "finding.planned";
export const FINDING_COMPLETED = "finding.completed";

// ── Task (IMPLEMENT) ────────────────────────────────────────────────────
export const TASK_SELECTED = "task.selected";
export const TASK_STARTED = "task.started";
export const TASK_COMPLETED = "task.completed";
export const TASK_FAILED = "task.failed";

// ── Delivery (DELIVER) ──────────────────────────────────────────────────
export const DELIVERY_REQUESTED = "delivery.requested";
export const DELIVERY_COMPLETED = "delivery.completed";
export const DELIVERY_MERGED = "delivery.merged";

// ── Feedback & Review (RE-IMPLEMENT) ────────────────────────────────────
export const FEEDBACK_RECEIVED = "feedback.received";
export const REVIEW_STARTED = "review.started";
export const REVIEW_COMPLETED = "review.completed";

// ── Observation (OBSERVE) ─────────────────────────────────────────────────
export const OBSERVATION_STARTED = "observation.started";
export const OBSERVATION_COMPLETED = "observation.completed";

// ── Assessment (ASSESS) ───────────────────────────────────────────────
export const ASSESSMENT_COMPLETED = "assessment.completed";

// ── Notification ────────────────────────────────────────────────────────
export const NOTIFICATION_SENT = "notification.sent";
export const NOTIFICATION_FAILED = "notification.failed";

// ── Optimization (LEARN) ────────────────────────────────────────────────
export const IMPROVER_STARTED = "improver.started";
export const IMPROVER_COMPLETED = "improver.completed";
