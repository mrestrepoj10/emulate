import { createHash } from "node:crypto";
import type { Store } from "@emulators/core";
import type {
  ApsManifestDerivative,
  ApsTranslationJob,
  ApsTranslationJobStatus,
  ApsTranslationOutputFormat,
} from "./entities.js";
import { documentFileType } from "./dm-tree.js";
import { getTranslationConfig } from "./ingestion-config.js";
import type { ApsStore } from "./store.js";
import { simulateWebhookEvent, type ApsWebhookEventInput } from "./webhooks.js";

export interface TranslationManifest {
  type: string;
  hasThumbnail: string;
  status: ApsTranslationJobStatus;
  progress: string;
  region: string;
  urn: string;
  version: string;
  derivatives: ApsManifestDerivative[];
}

function terminal(status: ApsTranslationJobStatus): boolean {
  return status === "success" || status === "failed";
}

function extractionFinishedEvent(job: ApsTranslationJob): ApsWebhookEventInput {
  const workflow = "emulate-translation";
  return {
    system: "derivative",
    event: "extraction.finished",
    resourceUrn: job.urn,
    region: job.region,
    scope: { workflow },
    payload: {
      TimeStamp: Date.now(),
      URN: job.urn,
      EventType: "EXTRACTION_FINISHED",
      Payload: { status: job.status, scope: workflow, registerKey: [] },
    },
  };
}

async function emitTerminalWebhook(aps: ApsStore, store: Store, job: ApsTranslationJob): Promise<ApsTranslationJob> {
  if (!terminal(job.status) || job.webhook_emitted) return job;
  const guarded = aps.translationJobs.update(job.id, { webhook_emitted: true }) ?? job;
  await simulateWebhookEvent(aps, store, extractionFinishedEvent(guarded));
  return guarded;
}

export function enqueueTranslation(
  aps: ApsStore,
  store: Store,
  input: {
    urn: string;
    sourceName: string;
    region?: string;
    outputFormats?: ApsTranslationOutputFormat[];
    force?: boolean;
  },
): { job: ApsTranslationJob; created: boolean } {
  const existing = aps.translationJobs.findOneBy("urn", input.urn);
  if (existing && !input.force) {
    const job =
      !terminal(existing.status) && input.outputFormats
        ? (aps.translationJobs.update(existing.id, { output_formats: structuredClone(input.outputFormats) }) ??
          existing)
        : existing;
    return { job, created: false };
  }
  const now = Date.now();
  const durationMs = getTranslationConfig(store).durationMs;
  const data = {
    source_name: input.sourceName,
    region: (input.region ?? "US").toUpperCase(),
    status: "pending" as const,
    progress: "0% complete",
    started_at: new Date(now).toISOString(),
    completes_at: new Date(now + durationMs).toISOString(),
    output_formats: structuredClone(input.outputFormats ?? [{ type: "svf2" as const, views: ["2d", "3d"] }]),
    force_count: existing ? existing.force_count + 1 : 0,
    webhook_emitted: false,
  };
  if (existing) {
    return { job: aps.translationJobs.update(existing.id, data) ?? existing, created: true };
  }
  return { job: aps.translationJobs.insert({ urn: input.urn, ...data }), created: true };
}

function successfulDerivative(job: ApsTranslationJob, format: ApsTranslationOutputFormat): ApsManifestDerivative {
  if (format.type === "thumbnail") {
    return { name: job.source_name, status: "success", progress: "complete", outputType: "thumbnail" };
  }
  const digest = createHash("sha1").update(`${job.urn}:${format.type}`).digest("hex");
  const guid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return {
    name: job.source_name,
    status: "success",
    progress: "complete",
    outputType: format.type,
    children: [
      {
        guid,
        type: "geometry",
        role: "3d",
        name: "{3D}",
        viewableID: "emulate-3d-view",
        status: "success",
        progress: "complete",
      },
    ],
  };
}

function derivativesForJob(job: ApsTranslationJob): ApsManifestDerivative[] {
  switch (job.status) {
    case "success":
      return job.output_formats.map((format) => successfulDerivative(job, format));
    case "failed":
      return [
        {
          name: job.source_name,
          status: "failed",
          progress: "complete",
          outputType: job.output_formats[0]?.type ?? "svf2",
          messages: [
            {
              type: "error",
              code: "TranslationFailed",
              message: `Translation is configured to fail for .${documentFileType(job.source_name)} files.`,
            },
          ],
        },
      ];
    default:
      return job.output_formats.map((format) => ({
        name: job.source_name,
        status: job.status,
        progress: job.progress,
        outputType: format.type,
      }));
  }
}

export function manifestForJob(job: ApsTranslationJob): TranslationManifest {
  return {
    type: "manifest",
    hasThumbnail: String(job.output_formats.some((format) => format.type === "thumbnail")),
    status: job.status,
    progress: job.progress,
    region: job.region,
    urn: job.urn,
    version: "1.0",
    derivatives: derivativesForJob(job),
  };
}

export async function refreshTranslationJob(
  aps: ApsStore,
  store: Store,
  job: ApsTranslationJob,
  now = Date.now(),
): Promise<ApsTranslationJob> {
  if (terminal(job.status)) return emitTerminalWebhook(aps, store, job);
  const started = Date.parse(job.started_at);
  const completes = Date.parse(job.completes_at);
  let next = job;
  if (now >= completes) {
    const extension = documentFileType(job.source_name);
    const failed = getTranslationConfig(store).failForExtensions.includes(extension);
    next =
      aps.translationJobs.update(job.id, {
        status: failed ? "failed" : "success",
        progress: "complete",
      }) ?? job;
  } else {
    const duration = Math.max(1, completes - started);
    const ratio = Math.max(0, Math.min(1, (now - started) / duration));
    if (ratio >= 0.1) {
      const percent = Math.min(75, Math.max(25, Math.floor(ratio * 4) * 25));
      next = aps.translationJobs.update(job.id, { status: "inprogress", progress: `${percent}% complete` }) ?? job;
    }
  }
  return emitTerminalWebhook(aps, store, next);
}

export async function forceTranslationTerminal(
  aps: ApsStore,
  store: Store,
  job: ApsTranslationJob,
  status: "success" | "failed",
): Promise<ApsTranslationJob> {
  const now = new Date().toISOString();
  const alreadyEmittedForOutcome = job.status === status ? job.webhook_emitted : false;
  const updated =
    aps.translationJobs.update(job.id, {
      status,
      progress: "complete",
      completes_at: now,
      webhook_emitted: alreadyEmittedForOutcome,
    }) ?? job;
  return emitTerminalWebhook(aps, store, updated);
}
