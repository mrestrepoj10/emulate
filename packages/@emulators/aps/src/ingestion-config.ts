import type { Store } from "@emulators/core";
import {
  DEFAULT_TRANSLATION_CONFIG,
  DEFAULT_UPLOAD_CONFIG,
  type ApsTranslationConfig,
  type ApsUploadConfig,
} from "./config.js";

const UPLOAD_CONFIG_KEY = "aps.uploadConfig";
const TRANSLATION_CONFIG_KEY = "aps.translationConfig";

export function getUploadConfig(store: Store): ApsUploadConfig {
  return { ...DEFAULT_UPLOAD_CONFIG, ...(store.getData<Partial<ApsUploadConfig>>(UPLOAD_CONFIG_KEY) ?? {}) };
}

export function setUploadConfig(store: Store, input: Partial<ApsUploadConfig>): void {
  if (input.maxObjectBytes !== undefined && (!Number.isSafeInteger(input.maxObjectBytes) || input.maxObjectBytes < 1)) {
    throw new Error("APS upload.maxObjectBytes must be a positive integer.");
  }
  store.setData(UPLOAD_CONFIG_KEY, { ...getUploadConfig(store), ...input });
}

export function getTranslationConfig(store: Store): ApsTranslationConfig {
  const configured = store.getData<Partial<ApsTranslationConfig>>(TRANSLATION_CONFIG_KEY) ?? {};
  return {
    ...DEFAULT_TRANSLATION_CONFIG,
    ...configured,
    failForExtensions: [...(configured.failForExtensions ?? DEFAULT_TRANSLATION_CONFIG.failForExtensions)],
  };
}

export function setTranslationConfig(store: Store, input: Partial<ApsTranslationConfig>): void {
  if (input.autoTranslateOnVersionAdd !== undefined && typeof input.autoTranslateOnVersionAdd !== "boolean") {
    throw new Error("APS translation.autoTranslateOnVersionAdd must be a boolean.");
  }
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) {
    throw new Error("APS translation.durationMs must be a non-negative number.");
  }
  if (
    input.failForExtensions !== undefined &&
    (!Array.isArray(input.failForExtensions) || input.failForExtensions.some((value) => typeof value !== "string"))
  ) {
    throw new Error("APS translation.failForExtensions must contain strings.");
  }
  store.setData(TRANSLATION_CONFIG_KEY, {
    ...getTranslationConfig(store),
    ...input,
    ...(input.failForExtensions
      ? { failForExtensions: input.failForExtensions.map((value) => value.toLowerCase().replace(/^\./, "")) }
      : {}),
  });
}
