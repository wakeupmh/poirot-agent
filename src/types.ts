/**
 * Shared types for the Poirot investigator.
 */

/**
 * The investigation request. Populated from CodeBuild environment variables,
 * which the trigger Lambda fills in from the CloudWatch alarm / SNS event
 * (or which you pass manually via `aws codebuild start-build`).
 */
export interface InvestigationContext {
  /** Human-readable reason the investigation was started (alarm name, incident title). */
  trigger: string;
  /** AWS region to investigate first. */
  region: string;
  /** Log groups most likely to hold the relevant errors. May be empty. */
  logGroups: string[];
  /** Service / application name, if known. Helps Poirot narrow its search. */
  service?: string;
  /** ISO-8601 start of the window of interest. Defaults to 1h before `windowEnd`. */
  windowStart: string;
  /** ISO-8601 end of the window of interest. Defaults to now. */
  windowEnd: string;
  /** Raw alarm or incident payload, passed through verbatim for extra context. */
  rawPayload?: string;
}
