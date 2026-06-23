"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

const DEBOUNCE_MS = 250;

/**
 * Free-text filters in the /executions advanced panel: work-item id
 * substring + exact PR number. Both push their value into the query
 * string after a 250 ms debounce so typing doesn't cause a request per
 * keystroke. Empty value removes the param.
 *
 * Renders as a client component so URL changes hit `router.replace`
 * without a full server round-trip; the parent server page picks up
 * the new params on the next render.
 */
export function ExecutionsIdFilter(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const initialWorkItem = params.get("workItem") ?? "";
  const initialPr = params.get("pr") ?? "";

  const [workItem, setWorkItem] = useState(initialWorkItem);
  const [pr, setPr] = useState(initialPr);
  const lastWorkItemRef = useRef(initialWorkItem);
  const lastPrRef = useRef(initialPr);

  useEffect(() => {
    setWorkItem(initialWorkItem);
    lastWorkItemRef.current = initialWorkItem;
  }, [initialWorkItem]);

  useEffect(() => {
    setPr(initialPr);
    lastPrRef.current = initialPr;
  }, [initialPr]);

  useEffect(() => {
    if (workItem === lastWorkItemRef.current && pr === lastPrRef.current) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (workItem.trim()) next.set("workItem", workItem.trim());
      else next.delete("workItem");
      if (pr.trim()) next.set("pr", pr.trim());
      else next.delete("pr");
      lastWorkItemRef.current = workItem;
      lastPrRef.current = pr;
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [workItem, pr, pathname, params, router]);

  return (
    <div className="space-y-1.5 px-3">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Match by id
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={workItem}
          onChange={(e) => setWorkItem(e.target.value)}
          placeholder="Work item id (e.g. F20260416-0001)"
          className="h-8 max-w-xs flex-1"
          aria-label="Filter by work item id"
        />
        <Input
          type="search"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pr}
          onChange={(e) => setPr(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="PR #"
          className="h-8 w-28"
          aria-label="Filter by PR number"
        />
      </div>
    </div>
  );
}
