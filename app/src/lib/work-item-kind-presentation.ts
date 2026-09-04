import type { CSSProperties } from "react";
import type { KVStore } from "@operator/core";
import { BaselineNotFoundError, loadBaselineValue } from "./baseline.js";

interface KindValue {
  readonly label?: unknown;
  readonly color?: unknown;
}

export interface WorkItemKindPresentation {
  readonly label: string;
  readonly color?: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function normalizedColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toUpperCase()
    : undefined;
}

export function resolveWorkItemKindPresentation(
  kind: string,
  current: KindValue | undefined,
  baseline: KindValue | undefined,
): WorkItemKindPresentation {
  const currentLabel = typeof current?.label === "string" ? current.label : undefined;
  const baselineLabel = typeof baseline?.label === "string" ? baseline.label : undefined;
  return {
    label: currentLabel ?? baselineLabel ?? kind,
    color: normalizedColor(current?.color) ?? normalizedColor(baseline?.color),
  };
}

export async function loadWorkItemKindPresentations(
  kv: KVStore,
  kinds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, WorkItemKindPresentation>> {
  const rows = await kv.list("work-item-kinds");
  const currentByKind = new Map(rows.map((row) => [row.key, row.value as KindValue]));
  const presentations = new Map<string, WorkItemKindPresentation>();

  await Promise.all(
    [...kinds].map(async (kind) => {
      const current = currentByKind.get(kind);
      let baseline: KindValue | undefined;
      if (!normalizedColor(current?.color) || typeof current?.label !== "string") {
        try {
          baseline = (await loadBaselineValue("work-item-kinds", kind)) as KindValue;
        } catch (error) {
          if (!(error instanceof BaselineNotFoundError)) throw error;
          // UI-created kinds need no shipped baseline; their DB values stand alone.
        }
      }
      presentations.set(kind, resolveWorkItemKindPresentation(kind, current, baseline));
    }),
  );

  return presentations;
}

export function workItemKindBadgeStyle(color: string | undefined): CSSProperties | undefined {
  const normalized = normalizedColor(color);
  if (!normalized) return undefined;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return {
    backgroundColor: normalized,
    borderColor: normalized,
    color: luminance >= 150 ? "#111827" : "#FFFFFF",
  };
}
