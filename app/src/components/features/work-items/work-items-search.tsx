"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

const DEBOUNCE_MS = 250;

export function WorkItemsSearch(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [value, setValue] = useState(initial);
  const lastPushedRef = useRef(initial);

  useEffect(() => {
    // URL changed externally (e.g. clear link, back button) — sync input.
    setValue(initial);
    lastPushedRef.current = initial;
  }, [initial]);

  useEffect(() => {
    if (value === lastPushedRef.current) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set("q", value);
      else next.delete("q");
      lastPushedRef.current = value;
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, pathname, params, router]);

  const hasValue = value.length > 0;

  return (
    <div className="relative flex-1 max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by id or title…"
        className={cn("pl-9", hasValue && "pr-9")}
        aria-label="Search work items"
      />
      {hasValue ? (
        <button
          type="button"
          onClick={() => setValue("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
