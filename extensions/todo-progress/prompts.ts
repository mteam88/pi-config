export const TASK_CREATE_PROMPT = `Create a task when work is complex enough to benefit from visible progress tracking.

Use tasks for multi-step implementation, investigation, or validation work. Skip them for trivial requests. Give each task a short action-oriented subject, a clear description, and optionally an activeForm for display while it is in progress. New tasks start as pending. Avoid duplicate tasks.`;

export const TASK_GET_PROMPT = `Retrieve one task by ID before acting on or updating it. The result includes its description, status, optional owner, active label, metadata, and dependency relationships. blockedBy contains only unfinished blockers; check that it is empty before starting blocked work.`;

export const TASK_UPDATE_PROMPT = `Update an existing task's fields, ownership, dependencies, metadata, or status. Move work from pending to in_progress when starting and to completed only after the described work and validation are fully done. Use deleted only to remove an obsolete or mistaken task. Read the latest task state first when it may have changed.`;

export const TASK_LIST_PROMPT = `List the current tasks with status, owner, and open blockers. Use this to choose the next unblocked pending task, check overall progress, or find work that is waiting on another task. Prefer available tasks in ID order unless priority or dependencies require otherwise.`;
